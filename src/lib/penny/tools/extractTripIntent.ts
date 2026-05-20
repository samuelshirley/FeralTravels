import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

/**
 * extract_trip_intent — the FIRST planning tool Penny calls once the driver's
 * request is specific enough to commit (or they explicitly defer all choices).
 * Forces a typed parse before any get_route or add_leg work.
 *
 * Why this exists:
 *  1. Feasibility math needs a clean source of truth for time_budget_days,
 *     overnight_nights, etc. Without a structured commit, Penny was happily
 *     building 19-day plans against a 14-day budget because the budget
 *     lived only in her head.
 *  2. Validated input shape is a defense layer against prompt-injection
 *     attempts — content that doesn't fit the schema gets dropped on the
 *     floor instead of influencing planning. (The bigger defense is still
 *     that Penny only owns trip-planning tools — there's no destructive
 *     tool an injection could pivot to.)
 *  3. Reusable pattern. Same skeleton can extend later (extract_segment_request,
 *     extract_fuel_preferences, extract_overnight_preferences, …).
 *
 * The server doesn't persist the parsed intent — it's a planning artifact.
 * The server validates, echoes the parsed struct back to Penny in the
 * tool_result so she has it as authoritative state, and surfaces any
 * warnings (e.g. "no time budget specified — assuming flexible").
 */

export const EXTRACT_TRIP_INTENT = 'extract_trip_intent' as const;

/**
 * One mandatory waypoint the user named.
 *
 * `nights` is bounded 0-30 — 0 covers "drive through, no overnight" detours
 * (rare but legal). The cap rejects obvious garbage; a real long stay would
 * be planned as a separate trip anyway.
 */
const waypointSchema = z.object({
  name: z.string().min(1).max(200),
  nights: z.number().int().min(0).max(30),
  /**
   * Free-text reason from the user — "stay at park", "visit family",
   * "scenic drive". Penny uses this to differentiate "stop overnight"
   * from "drive through" when emitting add_leg/add_stop later.
   */
  purpose: z.string().min(1).max(500).nullish(),
});

const baseSchema = z.object({
  /**
   * Origin and destination as free-text place names. Penny resolves these
   * to lat/lng later via her own geocoding heuristics + get_route. We
   * intentionally don't require lat/lng here — the user said "Tampa", we
   * shouldn't make Penny pre-geocode just to get the intent on record.
   */
  origin: z.string().min(1).max(200),
  destination: z.string().min(1).max(200),

  /**
   * Nights the user plans to stay at the final destination. These are
   * NOT counted against the transit budget — they happen after arrival.
   * 0 or null when the user didn't specify a destination stay.
   */
  destination_nights: z.number().int().min(0).max(60).nullable().optional().default(null),

  /**
   * Stops the user explicitly named as required ALONG THE ROUTE (transit
   * stops). Empty array is legal — a single A-to-B trip with no
   * constraints is a valid intent. Do NOT include the final destination
   * here — its nights go in destination_nights above.
   */
  mandatory_waypoints: z.array(waypointSchema).max(20),

  /**
   * Total trip length budget in days, parsed from the user's message
   * ("two weeks" → 14, "10 days" → 10). null when the user gave no
   * budget — Penny treats that as "flexible, plan minimum needed".
   *
   * IMPORTANT: This is the TRANSIT budget — the number of days the user
   * has to ARRIVE at the destination. It does NOT include nights at the
   * final destination. Parse "I need to be there by June 3" as the
   * number of days from departure to arrival.
   *
   * Bounds: 1-365. A 0-day trip is meaningless; >365 days is almost
   * certainly a parse error or someone abusing the input.
   */
  time_budget_days: z.number().int().min(1).max(365).nullable(),

  /**
   * Free-text bucket for everything else the user said that doesn't
   * fit the structured fields — "iconic parks", "avoid highways",
   * "we have a dog", etc. Penny uses this to flavor planning decisions
   * but it can't drive validation. Capped to keep prompt-injection
   * payloads from sneaking in via this side door.
   */
  notes: z.string().max(2000).nullish(),
});

export type ExtractTripIntentInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: EXTRACT_TRIP_INTENT,
  description:
    'Extract the user\'s trip-planning request into a typed structure. After any discovery-phase clarifications are resolved, call this BEFORE any get_route or add_leg whenever the user wants a new multi-segment trip plan or significantly changes scope. Skip it when the driver is still too vague to knowingly confirm assumptions — reply in prose-only first (see system prompt discovery_phase). Returns the validated parse plus warnings (e.g. "no time budget specified"). Penny then uses time_budget_days and mandatory_waypoints[].nights as the source of truth for feasibility. Do NOT call this for small tweaks ("move leg 3 a day later", "add a fuel stop near Marseille") — only for full or near-full plan creation.',
  input_schema: {
    type: 'object',
    required: ['origin', 'destination', 'mandatory_waypoints', 'time_budget_days'],
    properties: {
      origin: {
        type: 'string',
        description: 'Free-text origin place name as the user gave it (e.g. "Tampa, Florida").',
      },
      destination: {
        type: 'string',
        description: 'Free-text destination place name (e.g. "Seattle, Washington").',
      },
      destination_nights: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 60,
        description:
          'Nights the user plans to stay AT the final destination. These happen AFTER arrival and are NOT counted against the transit budget. Use null or 0 if the user didn\'t specify a destination stay. Example: "4 days in Bad Kissingen" → destination_nights: 4.',
      },
      mandatory_waypoints: {
        type: 'array',
        description:
          'TRANSIT stops the user explicitly required along the route, in order. Do NOT include the final destination here — its nights go in destination_nights. Use [] if the user named no transit stops.',
        items: {
          type: 'object',
          required: ['name', 'nights'],
          properties: {
            name: { type: 'string', description: 'Place name (e.g. "Grand Canyon").' },
            nights: {
              type: 'number',
              description:
                'Nights the user wants to stay (integer, 0-30). Use 1 by default for any waypoint the user named as a stopping point along the route — naming a city ("then to Innsbruck") implies an overnight there. Use 0 ONLY when the user explicitly said something like "drive through" or "don\'t stop" for that waypoint. Use 2+ when the user gave a duration ("two nights in Moab", "a long weekend in Asheville").',
            },
            purpose: {
              type: 'string',
              description:
                'Optional free-text reason from the user, e.g. "stay at park", "visit family".',
            },
          },
        },
      },
      time_budget_days: {
        type: ['integer', 'null'],
        description:
          'Total trip length the user stated, in days. Parse "two weeks" → 14, "10 days" → 10, "a long weekend" → 4. Use null only when the user said nothing about duration.',
      },
      notes: {
        type: 'string',
        description:
          'Everything else the user said that doesn\'t fit the structured fields — "iconic parks", "scenic only", "avoid tolls", etc. Keep concise.',
      },
    },
  },
};
