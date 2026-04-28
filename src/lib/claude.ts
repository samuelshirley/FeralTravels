import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { logAnthropicUsage } from '@/server/repos/usage';
import { buildPennyContext, type PennyContext } from '@/lib/penny/context';
import {
  ACTION_TOOL_NAMES,
  LOOKUP_TOOL_NAMES,
  TOOLS,
  VALIDATORS,
  type ValidatedAction,
  getRoute as getRouteTool,
} from '@/lib/penny/tools';
import { zodErrorToFeedback } from '@/lib/penny/tools/shared';
import { getDirections } from '@/lib/google/directions';
import { splitLegByDriveTime } from '@/lib/penny/split-route';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';

/**
 * How many times we'll feed validation failures back to Claude before
 * giving up and surfacing the failed actions to the user.
 *
 * Each retry is another Sonnet round-trip — paid for. We log retries to
 * usage_events so we can watch this number trend.
 */
const MAX_VALIDATION_RETRIES = 2;

/**
 * Hard ceiling on tool-use loop iterations regardless of validation
 * success. Protects against pathological loops where Claude keeps calling
 * lookup tools without ever ending her turn.
 */
const MAX_TOOL_USE_ITERATIONS = 8;

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT
//
// Tool definitions live in src/lib/penny/tools — Anthropic gets them as
// structured `tools` on every request. The prompt below is intent only:
// who Penny is, what she does and doesn't talk about, how to read context,
// and the planning rules that aren't expressible as Zod constraints.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `<role>
You are Penny, the trip planner for an overlanding road trip. You converse with the driver and call structured tools that mutate the trip plan.
</role>

<scope>
You ONLY discuss this user's overlanding trip plan. That includes: legs, routes, stops, fuel, water, overnight spots, trails, driving pace, weather/road conditions along the route, vehicle setup as it relates to the trip, border/ferry/visa logistics for the trip, gear packing for this trip.

If the user asks about anything else — code, general knowledge, therapy, relationships, other AIs, jokes, recipes unrelated to the trip, news, politics, trivia, their calendar, other apps, you-as-a-model — redirect in one short sentence back to the trip. Example redirects:
  "I only plan this trip — what do you want to do next on it?"
  "Outside my lane. Want me to look at leg 3 instead?"
Do not apologize. Do not explain at length. Do not use any tools for off-topic turns.

One exception: if the user's message is clearly a greeting ("hey", "thanks", "ok"), respond in one short sentence and propose the next planning step (e.g. "Yep — want me to plan fuel for Nice → Genoa?"). Never start a conversation from zero; always anchor to a concrete leg / stop / route on the trip.
</scope>

<style>
- Be concise. Default to 1–3 short sentences in your text response.
- No preamble, no recap of the user's message, no closing pleasantries.
- No bullet lists unless the user explicitly asks.
- If the user is just chatting, answer in plain prose only — do not call tools.
- When you make changes, give a one-sentence confirmation of WHAT changed and WHY in your text response, then let the tool calls speak for themselves.
- Never mark anything "selected" yourself — the user picks. Default new routes/stops to status="option".
</style>

<context_facts>
Each turn you receive a <context>…</context> block in the user message with this shape:
  trip       — { id, name, start_date, end_date, status }
  vehicle    — { name, vehicle_type, fuel_type, fuel_economy_kmpl, fuel_tank_l,
                  effective_range_km, max_drive_hours_per_day, … }
                effective_range_km = fuel_economy_kmpl × fuel_tank_l × 0.8 (flat 20% reserve).
                Treat it as the furthest distance you may plan between fuel stops.
  legs       — array of { id, title, start/end names + lat/lng, distance_km,
                drive_time_minutes, terrain, status, notes[], routes[], stops[], tasks[] }
  recentChat — last ~12 chat turns for short-term memory. Do NOT re-summarize them; just use them for continuity.
</context_facts>

<tool_use_protocol>
- Tool definitions describe valid inputs. Read each tool's description carefully — it tells you when to call it.
- ALWAYS call get_route FIRST when planning new legs that involve real driving. Never invent distance_km or drive_time_minutes from your own knowledge — you will be wrong, the validator will reject the leg, and Sam will see your retry as a regression.
- When a tool_result comes back with success, do NOT re-emit that tool call.
- When a tool_result comes back with is_error: true, fix the specific problem the error message describes and emit a corrected call. Do not retry an unchanged call — it will fail the same way.
- You may call multiple tools in one response (e.g. add_leg × N for a multi-day plan after one get_route).
</tool_use_protocol>

<fuel_planning_rules>
- Never plan a leg that relies on more than the vehicle's effective_range_km between fuel stops. If distance_km > effective_range_km, you MUST either (a) emit add_stop calls of stop_type "fuel" along the route, or (b) call plan_fuel_stops for that leg and explain briefly.
- For every fuel add_stop, populate distance_from_start_km (best-effort, measured along the driving route). Add fuel_type matching the vehicle when known.
- Prefer fuel stations you can name with confidence (brand + town). If you don't know real stations, still emit the call with name "Refuel near <town>" and source="penny" so the user knows to verify.
- Don't plan fuel at the same km as the leg destination — that's what overnight stops cover.
</fuel_planning_rules>

<route_planning_rules>
- When the user (or you) describes multi-option routes (Route A/B/C), emit them as separate add_route calls — never bury them in leg notes.
- For each route, attach links[] with the most useful canonical URLs. For "google_maps" links, ALWAYS use the Maps URLs API directions format with dir_action=navigate, e.g. https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG&travelmode=driving&dir_action=navigate — never /maps/place preview URLs or goo.gl short links.
- For overnight stops (status='option' routes that end at a different point than the leg), fill end_lat/end_lng/end_name/end_source/end_source_url. Keep status='option' — let the user pick.
- After proposing overnight route options, add a task titled "Pick tonight's stop" on that leg (priority normal). The UI auto-answers it when the user picks.
- Don't recreate routes/stops/tasks that already exist — update or extend them instead.
</route_planning_rules>

<leg_planning_rules>
- If the user asks for a plan and the trip has no legs, you MUST call get_route first to get authoritative distance/time, then emit one add_leg per driving day from get_route's suggested_split (or a single leg if the route fits in one day).
- The validator will reject any add_leg or update_leg with drive_time_minutes > vehicle.max_drive_hours_per_day × 60. Use get_route's split — don't try to override the cap with text reasoning.
- If the user gives only a destination with no origin, ask for the starting point in plain prose — do not call any tools yet.
- Height > 2.0 m: avoid low-clearance routes. Weight > 3500 kg: avoid narrow scrub tracks.
- Schedule water/blackwater refills at roughly water_refill_days / blackwater_refill_days intervals as add_task calls.
</leg_planning_rules>

<spot_discovery_note>
You do NOT have access to live spot databases or Google Places at query time. For overnight stops, emit add_stop with stop_type="overnight", coords, and a plausible town/park name (source="penny" so the user knows to verify). The UI automatically attaches "🐕 Dog parks nearby" and "🌳 Parks nearby" Google Maps search chips at the leg's end coords, plus a "Copy GPS" button on each stop — users discover the actual spot themselves and paste the coords back. When the user asks "find me a spot near X", propose a town/park near their route and mention those chips in one short sentence rather than inventing URLs.
</spot_discovery_note>`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface InputImage {
  dataUrl: string;
  mediaType: string;
}

export interface ReplanResult {
  /** Conversational text Penny says to the user (sum of all text blocks across iterations). */
  response: string;
  /** Action tool calls that passed validation, in emission order. */
  validatedActions: ValidatedAction[];
  /** Number of validation-retry round-trips we did. 0 if first response was clean. */
  retryCount: number;
  /** Tool calls that failed validation on the final attempt (surfaced to the user). */
  failedValidations: Array<{ tool: string; error: string }>;
  /** Was the loop terminated by hitting MAX_TOOL_USE_ITERATIONS? */
  truncated: boolean;
}

export async function replan(
  userMessage: string,
  tripId: number,
  images: InputImage[] = [],
  userId?: string
): Promise<ReplanResult> {
  if (!userId) throw new Error('userId is required for Penny replan');
  const context = await buildPennyContext(tripId, userId);
  if (!context) throw new Error('Trip not found');

  const userContent: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
  for (const img of images) {
    const match = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) continue;
    const mediaType = (img.mediaType || match[1]) as
      | 'image/jpeg'
      | 'image/png'
      | 'image/gif'
      | 'image/webp';
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: match[2] },
    });
  }
  userContent.push({
    type: 'text',
    text: renderContextMessage(context, userMessage),
  });

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];
  const textChunks: string[] = [];
  const validatedActions: ValidatedAction[] = [];
  const failedValidations: Array<{ tool: string; error: string }> = [];
  let retryCount = 0;
  let truncated = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let iteration = 0; iteration < MAX_TOOL_USE_ITERATIONS; iteration++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      await logAnthropicUsage({
        userId,
        tripId,
        model: MODEL,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        success: false,
        errorMessage: String((err as Error)?.message ?? err).slice(0, 500),
      }).catch(() => {});
      throw err;
    }

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    // Collect text blocks from this iteration.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim().length > 0) {
        textChunks.push(block.text);
      }
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    // No tool calls this iteration → Penny is done. Either she chatted, or
    // she wrapped up after a previous round of tool calls.
    if (toolUses.length === 0) {
      break;
    }

    // Process each tool_use block. For lookup tools (get_route) we execute
    // server-side and feed the data back. For action tools we validate; on
    // success we accumulate, on failure we surface the error so Claude can
    // correct.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let hadValidationFailure = false;

    for (const tu of toolUses) {
      if (LOOKUP_TOOL_NAMES.has(tu.name)) {
        const result = await executeLookupTool(tu, context);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: result.is_error,
          content: result.content,
        });
        continue;
      }

      if (!ACTION_TOOL_NAMES.has(tu.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Unknown tool: ${tu.name}.`,
        });
        hadValidationFailure = true;
        continue;
      }

      const validatorFactory = VALIDATORS[tu.name];
      const schema = validatorFactory(context);
      const parsed = schema.safeParse(tu.input);
      if (parsed.success) {
        validatedActions.push({
          name: tu.name as ValidatedAction['name'],
          input: parsed.data,
        } as ValidatedAction);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: false,
          content: 'Validated and queued. Do not re-emit this call.',
        });
      } else {
        hadValidationFailure = true;
        const feedback = zodErrorToFeedback(parsed.error);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Validation error: ${feedback}. Emit a corrected call addressing this specific issue.`,
        });
      }
    }

    // Append the assistant turn and our tool_results so Claude can continue.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // If this round had validation failures, count it as a retry.
    if (hadValidationFailure) {
      retryCount += 1;
      if (retryCount > MAX_VALIDATION_RETRIES) {
        // Out of retries — collect any still-failing actions for the user
        // response and bail.
        for (let i = 0; i < toolUses.length; i++) {
          const tu = toolUses[i];
          const tr = toolResults[i];
          if (tr.is_error && ACTION_TOOL_NAMES.has(tu.name)) {
            failedValidations.push({
              tool: tu.name,
              error: typeof tr.content === 'string' ? tr.content : 'Unknown validation error.',
            });
          }
        }
        break;
      }
    }

    // Anthropic signals "I'm done with tool calls" via stop_reason. If she
    // stopped without producing more tool_use, we'll exit on the next
    // iteration's empty toolUses check; we don't break early here because
    // we want to give her one more turn to acknowledge tool_results.
    if (response.stop_reason === 'end_turn' && !hadValidationFailure) {
      // Nothing more for Claude to do; exit before the extra round-trip.
      break;
    }

    if (iteration === MAX_TOOL_USE_ITERATIONS - 1) {
      truncated = true;
    }
  }

  await logAnthropicUsage({
    userId,
    tripId,
    model: MODEL,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    success: true,
  }).catch((e) => console.warn('logAnthropicUsage failed:', e));

  return {
    response: textChunks.join('\n\n').trim(),
    validatedActions,
    retryCount,
    failedValidations,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Lookup tool execution
// ---------------------------------------------------------------------------

interface LookupResult {
  is_error: boolean;
  content: string;
}

async function executeLookupTool(
  toolUse: Anthropic.ToolUseBlock,
  context: PennyContext
): Promise<LookupResult> {
  if (toolUse.name === getRouteTool.GET_ROUTE) {
    return executeGetRoute(toolUse, context);
  }
  return {
    is_error: true,
    content: `Unhandled lookup tool: ${toolUse.name}.`,
  };
}

async function executeGetRoute(
  toolUse: Anthropic.ToolUseBlock,
  context: PennyContext
): Promise<LookupResult> {
  // Validate Penny's inputs through the same Zod schema as everything else
  // — this gives us bounded lat/lng before we hit the Google API.
  const schema = getRouteTool.validator(context);
  const parsed = schema.safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      is_error: true,
      content: `Validation error on get_route inputs: ${zodErrorToFeedback(parsed.error)}.`,
    };
  }

  const input = parsed.data as getRouteTool.GetRouteInput;
  const directions = await getDirections(
    { lat: input.origin_lat, lng: input.origin_lng },
    { lat: input.destination_lat, lng: input.destination_lng },
    {
      avoid: input.avoid ?? undefined,
    }
  );

  if (!directions.ok) {
    return {
      is_error: true,
      content: `get_route failed: ${directions.kind} — ${directions.message}. ${
        directions.kind === 'no_results'
          ? 'Try alternative coordinates or ask the user for a different start/end.'
          : 'Tell the user this lookup is temporarily unavailable; do not invent the numbers.'
      }`,
    };
  }

  const cap = context.vehicle?.max_drive_hours_per_day;
  const exceedsCap = cap != null && directions.drive_time_minutes > cap * 60;

  let suggestedSplit: ReturnType<typeof splitLegByDriveTime> | null = null;
  if (exceedsCap && cap != null) {
    suggestedSplit = splitLegByDriveTime({
      polyline_points: directions.polyline_points,
      total_distance_km: directions.distance_km,
      total_drive_time_minutes: directions.drive_time_minutes,
      max_drive_minutes_per_day: cap * 60,
    });
  }

  // Emit a compact JSON payload for Claude to consume. Drop the raw
  // polyline (hundreds of points = thousands of tokens); send only what
  // Claude needs to plan with.
  const payload = {
    ok: true,
    distance_km: directions.distance_km,
    drive_time_minutes: directions.drive_time_minutes,
    start_address: directions.start_address,
    end_address: directions.end_address,
    warnings: directions.warnings,
    cached: directions.cached,
    exceeds_daily_cap: exceedsCap,
    daily_cap_minutes: cap != null ? cap * 60 : null,
    suggested_split: suggestedSplit?.map((leg) => ({
      day_index: leg.day_index,
      start_lat: round5(leg.start_lat),
      start_lng: round5(leg.start_lng),
      end_lat: round5(leg.end_lat),
      end_lng: round5(leg.end_lng),
      distance_km: leg.distance_km,
      drive_time_minutes: leg.drive_time_minutes,
    })) ?? null,
  };

  return {
    is_error: false,
    content: JSON.stringify(payload),
  };
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderContextMessage(ctx: PennyContext, userMessage: string): string {
  const contextJson = JSON.stringify(ctx, null, 2);
  const request = userMessage?.trim() || '(no text — see attached image(s))';
  return `<context>\n${contextJson}\n</context>\n\nUser request: ${request}`;
}
