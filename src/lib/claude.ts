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
  extractTripIntent as extractTripIntentTool,
  checkTripFeasibility as checkTripFeasibilityTool,
} from '@/lib/penny/tools';
import { zodErrorToFeedback } from '@/lib/penny/tools/shared';
import { getDirections } from '@/lib/google/directions';
import { splitLegByDriveTime } from '@/lib/penny/split-route';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Prompt caching
//
// The system prompt + tool schemas are stable across every iteration of the
// tool-use loop (and across most replan calls within a 5-min window). Marking
// them with cache_control: ephemeral lets Anthropic serve them from cache at
// 0.10× the base input price after the first request, vs paying the full
// $3/MTok every iteration.
//
// We also mark a rolling cache_control on the most recent tool_result block
// so iteration N+1 reads iteration N's accumulated history from cache.
//
// Anthropic allows up to 4 cache_control breakpoints per request:
//   1. End of system prompt
//   2. End of tools array (covers system + tools)
//   3. Rolling, on the latest tool_result (covers system + tools + history)
//
// Docs: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
// ---------------------------------------------------------------------------

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
 *
 * Sized so a multi-waypoint trip (e.g. Tampa → Smoky → Grand Canyon → Moab
 * → Seattle) can complete even if Penny serializes one segment per turn:
 * worst case is ~2N+1 iterations for N segments. The system prompt also
 * pushes her to batch get_route calls in parallel, which collapses that to
 * ~2-3 iterations in the common case — so this is mostly a safety net.
 *
 * Cost ceiling: 16 iterations × max_tokens=4096 ≈ ~65K output tokens per
 * request. The per-user $5/day spend cap (REPLAN_USD_CAP_PER_DAY) and
 * 40-req/hour cap (REPLAN_REQUESTS_PER_HOUR) bound the blast radius.
 */
const MAX_TOOL_USE_ITERATIONS = 16;

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

<closing_questions>
Never end a response with offers to plan things the system already automates. The following questions are BANNED in any phrasing:
  - "Need me to plan fuel stops?"
  - "Want me to plan fuel?"
  - "Need me to plan overnight stops?"
  - "Want me to plan overnight options?"
  - "Need me to plan fuel stops or overnight for any legs?"

Why: fuel stations and stretch-break rests are auto-planned server-side after every leg edit. Each driving leg ends at an overnight city by construction (the leg's end_name IS the overnight). The user does not need to opt in to either.

If you genuinely need user input on a leg, ask ONE specific question grounded in concrete leg detail (e.g. "Day 3 is gravel — keep the pass or route around?"). Never offer an open menu.
</closing_questions>

<plan_summary_format>
When you emit a multi-leg plan in a single turn (any turn that batches add_leg calls for a fresh route), your closing text response MUST be:

1. ONE short opening sentence acknowledging the plan ("Plan saved." / "Your mountain adventure is set.").
2. ONE blank line.
3. ONE recap line per driving day in this exact shape (no bullets, no numbering, plain text, one per line):
   Day N: <start> → <end>, ~<H>h, <terrain>, overnight <end-city>
   Example: Day 3: Milan → Innsbruck, ~5.8h, gravel pass, overnight Innsbruck

This replaces any phrasing like "no overnight waypoint stops" or "no overnight stops needed" — the leg's end_name IS the overnight, and the recap line says so explicitly. Do not say a plan has "no overnight stops" when each leg ends at a destination city.

Skip this format on small tweaks (single leg edits, single stop additions, conversational replies) — only apply it to fresh batched plans.
</plan_summary_format>

<units>
This app is metric-only. Always express distances in kilometers (km), driving times in hours/minutes, fuel volumes in liters, temperatures in Celsius. NEVER use miles, mph, gallons, Fahrenheit, or any other imperial unit in your responses, even if the user uses them.

If the user mentions an imperial unit (miles, mph, gallons, °F, feet, etc.), respond with one short deadpan line that you don't recognize that unit, then plan in metric using your best metric estimate. Examples:
  - User: "drive 500 miles tomorrow" → "I don't know what a 'mile' is — planning ~805 km."
  - User: "fill up 10 gallons" → "I don't speak imperial. Working in liters (~38 L)."
  - User: "it'll be 80°F" → "°F is not a unit I use. Planning around ~27°C."
Keep it dry — one short line, then proceed. Do not lecture, apologize, or explain why. Do not ask the user to switch units. Do not offer a unit selector. Just convert and move on.
</units>

<vehicle_preference_updates>
When the user states or changes a driving preference in chat (daily hours, weekly driving days, refuel cadence, water/blackwater intervals) — whether you asked for it or they volunteered it — call update_vehicle immediately.

Parse their freeform answer into metric numbers:
  "6 hours a day, 3 days a week" → max_drive_hours_per_day: 6, max_consecutive_drive_days: 3, max_drive_hours_per_week: 18
  "refuel every 400 km" → refill_distance_km: 400
  "drive 5 days then rest" → max_consecutive_drive_days: 5

Only supply fields the user actually stated — leave the rest out of the call so existing values aren't overwritten.

After update_vehicle succeeds, confirm in one sentence ("Saved: 6 h/day, 3 consecutive days.") and proceed with planning. Do NOT ask the user to restate preferences in a different format. Do NOT say you don't recognize the input.

Important: leg validation in the SAME turn still uses the vehicle values from before the update. If you've just updated the daily cap and need to add legs that depend on it, tell the user the preferences are saved and ask them to send the planning request again — it will pick up the new cap.

The "I don't recognize" line from the units section is ONLY for imperial units (miles, gallons, °F, etc.). Never apply it to driving-time or cadence preferences stated in hours, days, or weeks.
</vehicle_preference_updates>

<context_facts>
Each turn you receive a <context>…</context> block in the user message with this shape:
  trip       — { id, name, start_date, end_date, status }
  vehicle    — { name, refill_distance_km, effective_range_km,
                  max_drive_hours_per_day, max_drive_hours_per_week,
                  max_consecutive_drive_days, water_refill_days,
                  blackwater_refill_days }
                effective_range_km mirrors refill_distance_km — the user's
                stated preferred distance between fuel stops. Treat it as the
                furthest distance you may plan between fuel stops. (No
                fuel-tank or fuel-economy fields exist; the user-stated
                cadence is the source of truth.)
  legs       — array of { id, title, start/end names + lat/lng, distance_km,
                drive_time_minutes, terrain, status, notes[], routes[], stops[], tasks[],
                sort_order }
                For every tool that takes leg_id, use the object's numeric **id**
                field from legs[] above — never substitute sort_order,
                ordinal position, or a day counter (e.g. "Day 2") for id. After one
                turn changes legs, reload uses fresh ids from subsequent context.
  recentChat — last ~12 chat turns for short-term memory. Do NOT re-summarize them; just use them for continuity.
</context_facts>

<tool_use_protocol>
- Tool definitions describe valid inputs. Read each tool's description carefully — it tells you when to call it.
- ALWAYS call get_route FIRST when planning new legs that involve real driving. Never invent distance_km or drive_time_minutes from your own knowledge — you will be wrong, the validator will reject the leg, and Sam will see your retry as a regression.
- When a tool_result comes back with success, do NOT re-emit that tool call.
- When a tool_result comes back with is_error: true, fix the specific problem the error message describes and emit a corrected call. Do not retry an unchanged call — it will fail the same way.
- You may call multiple tools in one response (e.g. add_leg × N for a multi-day plan after one get_route).

<batching_for_multi_waypoint_trips>
You have a hard cap on tool-use iterations per turn. Burning iterations one segment at a time will leave the user with a half-saved plan. Batch aggressively:

- When the user gives MULTIPLE mandatory waypoints in one message (e.g. "Tampa → Smoky → Grand Canyon → Moab → Seattle"), emit ALL the get_route calls — one per segment — IN PARALLEL in a single response. Do not call get_route, wait, then call the next get_route. Fire them together as N tool_use blocks in one assistant turn.
- After all those get_route results come back in one batched tool_result, emit ALL the add_leg calls for the entire trip in your next response — every driving day across every segment in one batched assistant turn.
- This collapses what would otherwise be ~2N+1 iterations down to 2-3 for any number of segments. It is the difference between a complete saved plan and a truncated one.
- Sequential get_route calls are still fine for single-segment work or follow-up tweaks. The batching rule only applies when the user has named multiple mandatory stops up front.
</batching_for_multi_waypoint_trips>
</tool_use_protocol>

<fuel_planning_rules>
- After get_route, if you add legs whose distance_km exceeds effective_range_km (or consecutive legs will exceed it before a real refuel), call plan_fuel_stops for each of those legs on the **same** turn. Do **not** ask "want me to plan fuel?" — run the tool unless the user clearly opted out of auto fuel.
- Prefer plan_fuel_stops over batches of guessed fuel add_stop rows when you need concrete stations; use fuel add_stop only when the user names a specific station or plan_fuel_stops is not appropriate.
- Never plan a leg that relies on more than effective_range_km between fuel stops without plan_fuel_stops and/or explicit fuel stops.
- For every fuel add_stop, populate distance_from_start_km (best-effort, measured along the driving route). Add fuel_type matching the vehicle when known.
- Prefer fuel stations you can name with confidence (brand + town). If you don't know real stations, use plan_fuel_stops instead of fabricating coordinates.
- Don't plan fuel at the same km as the leg destination — that's what overnight stops cover.
</fuel_planning_rules>

<route_vs_stop_decision>
This is the most common mistake to avoid. Read carefully:

- add_route is ONLY for alternative DESTINATIONS — i.e. multiple candidate overnight points at different end coords. Routes that share the same start and end but differ in path (e.g. "highway vs scenic", "via Millau Bridge", "via mountain pass") cannot be modeled as add_route, because the leg's "Open in Google Maps" button only reads a route's end coords — it does NOT read intermediate path data, and the route's links[] are not used for navigation. Selecting such a route would silently fall back to Google's default highway routing.
- For ANY landmark, bridge, pass, viewpoint, or detour the user wants to traverse on the way, use add_stop with stop_type="other", status="selected" (so it forces routing through), and a best-effort distance_from_start_km so it sorts correctly along the leg. The leg's "Open in Google Maps" URL will include selected stops as &waypoints= and Google Maps will route through them.
- Rule of thumb: "go via X" → add_stop. "Stop at X for the night" with multiple options → add_route (one per option, status='option').
</route_vs_stop_decision>

<route_planning_rules>
- When the user (or you) describes multi-DESTINATION routes (e.g. "Camp A vs Camp B vs Camp C for tonight"), emit them as separate add_route calls — never bury them in leg notes. See <route_vs_stop_decision>.
- For each route, attach links[] with the most useful canonical URLs. For "google_maps" links, ALWAYS use the Maps URLs API directions format with dir_action=navigate, e.g. https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG&travelmode=driving&dir_action=navigate — never /maps/place preview URLs or goo.gl short links.
- For overnight stops (status='option' routes that end at a different point than the leg), fill end_lat/end_lng/end_name/end_source/end_source_url. Keep status='option' — let the user pick.
- After proposing overnight route options, add a task titled "Pick tonight's stop" on that leg (priority normal). The UI auto-answers it when the user picks.
- Don't recreate routes/stops/tasks that already exist — update or extend them instead.
</route_planning_rules>

<intent_extraction>
For ANY new multi-segment trip plan or significant scope change to an existing trip, your VERY FIRST tool call must be extract_trip_intent. This forces you to commit to a typed parse of the user's request before any get_route or add_leg work.

Triggers — call extract_trip_intent first when:
  - The trip has no legs and the user describes a route (origin → destination, optionally with stops).
  - The user names multiple mandatory waypoints in one message ("hit Smoky, Grand Canyon, Moab").
  - The user gives or revises a time budget ("over two weeks", "10-day trip", "extend to 18 days").

Do NOT call it for small tweaks: "move leg 3 a day later", "add a fuel stop near Marseille", "swap the Yosemite night for Sequoia". For those, go straight to the relevant action tool.

When the tool returns, the parsed intent and total_overnight_nights become the authoritative source of truth for the feasibility check below. Do not re-derive the time budget or stop list from the user's prose after this point — use the parsed fields.
</intent_extraction>

<feasibility_check>
After extract_trip_intent and after you have called get_route for every segment between waypoints, you MUST call check_trip_feasibility BEFORE any add_leg.

Do NOT do the arithmetic yourself. The check_trip_feasibility tool runs deterministic JS on the server. You pass it:
  - segment_drive_days: array of min_driving_days from each get_route result, in route order
  - waypoint_nights: array of nights from each waypoint in your parsed intent, in route order
  - time_budget_days: from your parsed intent (may be null)

The tool returns a verdict:
  - "fits" → proceed with add_leg. Briefly mention totals in your response AND cite the active daily-driving cap from vehicle.max_drive_hours_per_day so the user sees it was honored ("12 driving days + 7 park nights = 19 days, fits your 21-day budget with 2 days of slack — within your 6h/day cap"). If max_drive_hours_per_day is null, omit the cap clause.
  - "tight" → proceed with add_leg, but tell the user there's no buffer for weather or rest.
  - "no_budget" → proceed with add_leg. Surface the total day count so the user sees what they're committing to.
  - "over_budget" → STOP. Do NOT call add_leg. Do NOT save anything. Respond in plain prose with:
      1. The numbers from the tool's summary field ("Your 14-day budget needs 20 days with these stops, short by 6.").
      2. Two specific options framed as a question — extending the trip to total_min_days_needed, OR dropping a specific stop. When suggesting which to drop, prefer the waypoint with the lowest nights or the weakest purpose string from your parsed intent (e.g. "stay" feels less mandatory than "anniversary dinner with parents").
      3. End by asking which they want.
    Wait for the user's reply. When they pick, call extract_trip_intent again with the revised inputs and re-run check_trip_feasibility.

This is a HARD gate enforced by the server. If you skip check_trip_feasibility on a fresh plan (when extract_trip_intent was called), the dispatcher rejects all your add_leg actions and the user sees a failure message — worse UX than if you'd just called the tool. Always call it.
</feasibility_check>

<leg_planning_rules>
- If the user asks for a plan and the trip has no legs, you MUST call extract_trip_intent first (see <intent_extraction>), then get_route for each segment, then run the <feasibility_check>, THEN emit one add_leg per driving day from get_route's suggested_split (or a single leg if the route fits in one day).
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
  /**
   * True if Penny called extract_trip_intent at any point in this turn.
   * Used by the dispatcher to decide whether the feasibility gate applies:
   * if false, this is a small tweak and add_legs are allowed without a
   * feasibility check; if true, this is a fresh plan and the feasibility
   * gate must have passed before add_legs are dispatched.
   */
  extractIntentCalled: boolean;
  /**
   * The verdict from the LATEST check_trip_feasibility call this turn,
   * or null if the tool was never called. The dispatcher uses this to
   * gate add_leg actions — null or 'over_budget' means reject.
   */
  feasibilityVerdict:
    | 'fits'
    | 'tight'
    | 'over_budget'
    | 'no_budget'
    | null;
}

/**
 * Stream events from the replan loop so the route handler can flush
 * Penny's progress to the UI per-iteration instead of buffering the whole
 * turn into a single JSON blob. Consumers iterate the generator, surface
 * `text` / `tool_started` / `tool_done` events as they arrive, and read
 * the final `ReplanResult` from the terminal `done` event.
 *
 * The non-streaming `replan()` below stays for callers that just want the
 * accumulated result (and as a thin guard against drift between the two
 * code paths).
 */
export type ReplanEvent =
  | { kind: 'iteration_start'; index: number }
  | { kind: 'text'; chunk: string }
  | { kind: 'tool_started'; name: string; toolUseId: string }
  | {
      kind: 'tool_done';
      name: string;
      toolUseId: string;
      ok: boolean;
      error?: string;
    }
  | { kind: 'done'; result: ReplanResult };

export async function replan(
  userMessage: string,
  tripId: number,
  images: InputImage[] = [],
  userId?: string
): Promise<ReplanResult> {
  for await (const ev of replanStream(userMessage, tripId, images, userId)) {
    if (ev.kind === 'done') return ev.result;
  }
  throw new Error('replanStream finished without yielding done');
}

export async function* replanStream(
  userMessage: string,
  tripId: number,
  images: InputImage[] = [],
  userId?: string
): AsyncGenerator<ReplanEvent, void, void> {
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
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  // System prompt + tools as cacheable structures. Built once per replan so
  // we're not rebuilding the array on every iteration.
  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const cachedTools: Anthropic.Tool[] = TOOLS.map((tool, i) =>
    i === TOOLS.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral' } }
      : tool
  );
  // Workflow gate tracking. The dispatcher in /api/trip/replan uses these
  // to decide whether add_leg actions are allowed: if extract_trip_intent
  // was called, this is a fresh plan and check_trip_feasibility must have
  // passed (or returned 'no_budget') before add_legs can land.
  let extractIntentCalled = false;
  let feasibilityVerdict: ReplanResult['feasibilityVerdict'] = null;

  for (let iteration = 0; iteration < MAX_TOOL_USE_ITERATIONS; iteration++) {
    yield { kind: 'iteration_start', index: iteration };
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: cachedSystem,
        tools: cachedTools,
        messages,
      });
    } catch (err) {
      await logAnthropicUsage({
        userId,
        tripId,
        model: MODEL,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        success: false,
        errorMessage: String((err as Error)?.message ?? err).slice(0, 500),
      }).catch(() => {});
      throw err;
    }

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;
    // Anthropic returns these as separate fields on usage. Sum them so we
    // can bill at the correct rates and observe cache hit rate per replan.
    totalCacheCreationTokens += response.usage?.cache_creation_input_tokens ?? 0;
    totalCacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;

    // Collect text blocks from this iteration. We yield them live so the
    // SSE consumer can append paragraphs to the assistant message bubble
    // as they arrive — the user sees Penny "thinking out loud" instead of
    // waiting for the full turn to land.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim().length > 0) {
        textChunks.push(block.text);
        yield { kind: 'text', chunk: block.text };
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
        yield { kind: 'tool_started', name: tu.name, toolUseId: tu.id };
        const result = await executeLookupTool(tu, context);
        yield {
          kind: 'tool_done',
          name: tu.name,
          toolUseId: tu.id,
          ok: !result.is_error,
          error: result.is_error
            ? typeof result.content === 'string'
              ? result.content.slice(0, 200)
              : 'Unknown error'
            : undefined,
        };
        // Workflow tracking — must happen here in the loop because each
        // iteration creates new tool_results, and we need cumulative state.
        // We track on success only; a failed extract_trip_intent doesn't
        // count as "fresh plan in progress".
        if (
          !result.is_error &&
          tu.name === extractTripIntentTool.EXTRACT_TRIP_INTENT
        ) {
          extractIntentCalled = true;
        }
        if (
          !result.is_error &&
          tu.name === checkTripFeasibilityTool.CHECK_TRIP_FEASIBILITY &&
          result.feasibilityVerdict
        ) {
          // Latest verdict wins — Penny may revise inputs and recheck.
          feasibilityVerdict = result.feasibilityVerdict;
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: result.is_error,
          content: result.content,
        });
        continue;
      }

      if (!ACTION_TOOL_NAMES.has(tu.name)) {
        yield { kind: 'tool_started', name: tu.name, toolUseId: tu.id };
        yield {
          kind: 'tool_done',
          name: tu.name,
          toolUseId: tu.id,
          ok: false,
          error: `Unknown tool: ${tu.name}.`,
        };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Unknown tool: ${tu.name}.`,
        });
        hadValidationFailure = true;
        continue;
      }

      yield { kind: 'tool_started', name: tu.name, toolUseId: tu.id };
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
        yield {
          kind: 'tool_done',
          name: tu.name,
          toolUseId: tu.id,
          ok: true,
        };
      } else {
        hadValidationFailure = true;
        const feedback = zodErrorToFeedback(parsed.error);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Validation error: ${feedback}. Emit a corrected call addressing this specific issue.`,
        });
        yield {
          kind: 'tool_done',
          name: tu.name,
          toolUseId: tu.id,
          ok: false,
          error: feedback.slice(0, 200),
        };
      }
    }

    // Append the assistant turn and our tool_results so Claude can continue.
    messages.push({ role: 'assistant', content: response.content });

    // Move the rolling cache breakpoint forward: strip cache_control from any
    // prior tool_result block, then mark the last tool_result of THIS turn so
    // it caches the system + tools + complete history up to here. The next
    // iteration reads everything up to this point at 0.10× input price.
    //
    // We strip first because Anthropic caps requests at 4 cache_control
    // markers — without removal, we'd accumulate one per iteration and hit
    // the cap by iteration 4.
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === 'tool_result' &&
            (block as Anthropic.ToolResultBlockParam).cache_control
          ) {
            delete (block as { cache_control?: unknown }).cache_control;
          }
        }
      }
    }
    if (toolResults.length > 0) {
      toolResults[toolResults.length - 1] = {
        ...toolResults[toolResults.length - 1],
        cache_control: { type: 'ephemeral' },
      };
    }
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

  // Quick visibility on cache effectiveness. Useful when tuning breakpoints
  // and after deploying — a healthy run should show cacheReadTokens dwarfing
  // cacheCreationTokens after iteration 1. If reads stay low, caching isn't
  // landing (e.g., system prompt being mutated, or 5-min TTL expired).
  const cacheTotal = totalCacheCreationTokens + totalCacheReadTokens;
  const cacheHitRate =
    cacheTotal > 0 ? (totalCacheReadTokens / cacheTotal).toFixed(2) : 'n/a';
  console.log(
    `[penny.replan] tripId=${tripId} input=${totalInputTokens} output=${totalOutputTokens} cacheWrite=${totalCacheCreationTokens} cacheRead=${totalCacheReadTokens} cacheHitRate=${cacheHitRate}`
  );

  await logAnthropicUsage({
    userId,
    tripId,
    model: MODEL,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationInputTokens: totalCacheCreationTokens,
    cacheReadInputTokens: totalCacheReadTokens,
    success: true,
  }).catch((e) => console.warn('logAnthropicUsage failed:', e));

  yield {
    kind: 'done',
    result: {
      response: textChunks.join('\n\n').trim(),
      validatedActions,
      retryCount,
      failedValidations,
      truncated,
      extractIntentCalled,
      feasibilityVerdict,
    },
  };
}

// ---------------------------------------------------------------------------
// Lookup tool execution
// ---------------------------------------------------------------------------

interface LookupResult {
  is_error: boolean;
  content: string;
  /**
   * Set only by executeCheckTripFeasibility — the verdict bubbles up to
   * the replan() loop so the dispatcher can gate add_leg actions on it.
   * Other lookup tools leave this undefined.
   */
  feasibilityVerdict?: ReplanResult['feasibilityVerdict'];
}

async function executeLookupTool(
  toolUse: Anthropic.ToolUseBlock,
  context: PennyContext
): Promise<LookupResult> {
  if (toolUse.name === getRouteTool.GET_ROUTE) {
    return executeGetRoute(toolUse, context);
  }
  if (toolUse.name === extractTripIntentTool.EXTRACT_TRIP_INTENT) {
    return executeExtractTripIntent(toolUse, context);
  }
  if (toolUse.name === checkTripFeasibilityTool.CHECK_TRIP_FEASIBILITY) {
    return executeCheckTripFeasibility(toolUse, context);
  }
  return {
    is_error: true,
    content: `Unhandled lookup tool: ${toolUse.name}.`,
  };
}

/**
 * check_trip_feasibility — runs the deterministic JS computation in
 * checkTripFeasibility.computeFeasibility and returns the verdict to Penny
 * AND surfaces it to the replan() loop so the dispatcher can gate add_leg.
 *
 * The `feasibilityVerdict` field on the LookupResult is the side-channel.
 * Penny sees the JSON content; the dispatcher sees the verdict via the
 * loop's tracking variable. Same source of truth either way.
 */
async function executeCheckTripFeasibility(
  toolUse: Anthropic.ToolUseBlock,
  context: PennyContext
): Promise<LookupResult> {
  const schema = checkTripFeasibilityTool.validator(context);
  const parsed = schema.safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      is_error: true,
      content: `Validation error on check_trip_feasibility: ${zodErrorToFeedback(parsed.error)}.`,
    };
  }

  const result = checkTripFeasibilityTool.computeFeasibility(
    parsed.data as checkTripFeasibilityTool.CheckTripFeasibilityInput
  );

  return {
    is_error: false,
    content: JSON.stringify(result),
    feasibilityVerdict: result.verdict,
  };
}

/**
 * extract_trip_intent doesn't write to the DB or hit any external API.
 * The server's job is just to:
 *   1. Validate the parse Penny committed to (via Zod)
 *   2. Echo it back so it's authoritative state in the conversation
 *   3. Surface gentle warnings (e.g. missing time budget) so Penny knows
 *      what's underspecified before she starts feasibility math
 *
 * Crucially we DON'T compute feasibility here — that requires get_route
 * results, which Penny calls next. Keeping this tool a pure parse-and-echo
 * means it's cheap (no I/O) and composable with any planning workflow.
 */
async function executeExtractTripIntent(
  toolUse: Anthropic.ToolUseBlock,
  context: PennyContext
): Promise<LookupResult> {
  const schema = extractTripIntentTool.validator(context);
  const parsed = schema.safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      is_error: true,
      content: `Validation error on extract_trip_intent: ${zodErrorToFeedback(parsed.error)}.`,
    };
  }

  const intent = parsed.data as extractTripIntentTool.ExtractTripIntentInput;

  // Diagnostic warnings — non-fatal, just hints to Penny about what's
  // missing so she can decide whether to proceed or ask the user.
  const warnings: string[] = [];
  if (intent.time_budget_days == null) {
    warnings.push(
      'No time_budget_days specified. The user did not state a trip length — proceed assuming flexible timing, or ask the user before committing to a long plan.'
    );
  }
  if (intent.mandatory_waypoints.length === 0) {
    warnings.push(
      'No mandatory_waypoints. If the user just wants the shortest A→B, that is fine — otherwise re-read their message for stops you may have missed.'
    );
  }

  // Sum of overnight nights the user explicitly requested. Penny needs this
  // for the feasibility check (driving_days + overnight_nights ≤ time_budget_days).
  const total_overnight_nights = intent.mandatory_waypoints.reduce(
    (sum, wp) => sum + wp.nights,
    0
  );

  return {
    is_error: false,
    content: JSON.stringify({
      ok: true,
      parsed: intent,
      total_overnight_nights,
      warnings,
      next_step:
        'Now call get_route in PARALLEL for each segment between waypoints (origin → wp1, wp1 → wp2, …, wpN → destination). Then sum min_driving_days across all results, add total_overnight_nights, compare to time_budget_days. If the sum exceeds the budget, STOP and ask the user to extend the trip or drop a stop — do NOT call add_leg.',
    }),
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

  // Minimum number of driving days this segment requires given the
  // vehicle's per-day cap. Used by Penny's feasibility check: she sums
  // min_driving_days across every get_route call, adds the user's
  // mandatory overnight nights, and compares to time_budget_days.
  // When no cap is set we fall back to "at least 1 day" — a single-day
  // trip without a cap is always feasible by definition.
  const minDrivingDays =
    cap != null
      ? Math.max(1, Math.ceil(directions.drive_time_minutes / (cap * 60)))
      : 1;

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
    min_driving_days: minDrivingDays,
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
