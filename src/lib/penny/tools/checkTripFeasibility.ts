import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

/**
 * check_trip_feasibility — deterministic server-side feasibility math.
 *
 * Penny calls this AFTER extract_trip_intent + all per-segment get_route
 * lookups, BEFORE any add_leg. The server runs the arithmetic in JS and
 * returns a verdict; Penny just relays it to the user (in her own voice
 * for over-budget cases — the server gives her the numbers, not the
 * recommendation phrasing).
 *
 * Why this exists as a tool instead of "Penny does the math herself":
 *   - At 10+ waypoints LLM arithmetic gets unreliable. Sonnet drops digits
 *     when summing lots of small numbers.
 *   - Even when she sums correctly, she can rationalize past the gate
 *     ("close enough", "with optimal driving"). Code doesn't rationalize.
 *   - The dispatcher in /api/trip/replan uses the recorded verdict as a
 *     server-side enforcement layer — if Penny skips this tool or it
 *     returned over_budget, add_leg actions are rejected. Belt + suspenders.
 *
 * Inputs come from Penny's prior tool calls — she fills them in herself
 * from the get_route results and the extract_trip_intent output. The
 * tool does not re-read PennyContext to fetch them; this keeps it a pure
 * computation that can be verified by inspection.
 */

export const CHECK_TRIP_FEASIBILITY = 'check_trip_feasibility' as const;

const baseSchema = z.object({
  /**
   * One entry per segment between waypoints, in route order. Source:
   * min_driving_days field from each get_route response.
   *
   * Bounds: ≤ 200 entries (would be a 200-segment trip — absurdly long
   * but not pathological), each value 1-60 (a 60-day single segment is
   * already absurd; > 60 means data error).
   */
  segment_drive_days: z.array(z.number().int().min(1).max(60)).min(1).max(200),

  /**
   * One entry per mandatory waypoint, in route order. Source: nights
   * field from each waypoint in extract_trip_intent's parsed output.
   *
   * Empty array is legal (an A→B trip with no overnight stops).
   * Per-waypoint cap of 30 nights matches the extract_trip_intent cap.
   */
  waypoint_nights: z.array(z.number().int().min(0).max(30)).max(50),

  /**
   * User's stated budget. Null = no budget; the tool returns verdict
   * 'no_budget' and the dispatcher allows add_leg.
   */
  time_budget_days: z.number().int().min(1).max(365).nullable(),

  /**
   * Optional safety margin for weather, rest days, contingencies.
   * Defaults to 0 (no margin). Penny may set this when she knows the
   * trip is in a bad-weather season or the user is towing.
   */
  buffer_days: z.number().int().min(0).max(60).optional().default(0),
});

export type CheckTripFeasibilityInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: CHECK_TRIP_FEASIBILITY,
  description:
    'Run the deterministic feasibility check on a multi-segment trip. Call this AFTER extract_trip_intent and AFTER you have called get_route for every segment, BEFORE any add_leg. Pass min_driving_days from each get_route result (in route order) as segment_drive_days, and the nights field from each waypoint in your parsed intent (in route order) as waypoint_nights. The server does the math and returns a verdict. If verdict is "over_budget" you MUST stop, relay the numbers to the user in plain prose, and ask them to extend the trip or drop a stop — do NOT call add_leg. The dispatcher will reject add_leg actions if this check did not pass.',
  input_schema: {
    type: 'object',
    required: ['segment_drive_days', 'waypoint_nights', 'time_budget_days'],
    properties: {
      segment_drive_days: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 60 },
        description:
          'min_driving_days from each get_route call, in route order. One entry per segment between waypoints.',
      },
      waypoint_nights: {
        type: 'array',
        items: { type: 'integer', minimum: 0, maximum: 30 },
        description:
          'nights from each mandatory_waypoint in extract_trip_intent, in route order. Empty array if no mandatory overnight stops.',
      },
      time_budget_days: {
        type: ['integer', 'null'],
        description:
          'time_budget_days from extract_trip_intent. null if the user gave no budget.',
      },
      buffer_days: {
        type: 'integer',
        minimum: 0,
        maximum: 60,
        description:
          'Optional safety margin in days for weather/rest/contingency. Default 0. Set 1-3 for bad-weather routes or heavy-load drives.',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Pure computation — exposed so the executor in claude.ts and any future
// caller (e.g. an admin diagnostic UI) can reuse the exact same logic.
// Keep this deterministic; no I/O, no state. Tested by inspection.
// ---------------------------------------------------------------------------

export type FeasibilityVerdict = 'fits' | 'tight' | 'over_budget' | 'no_budget';

export interface FeasibilityResult {
  feasible: boolean;
  total_driving_days: number;
  total_overnight_nights: number;
  buffer_days: number;
  total_min_days_needed: number;
  budget_days: number | null;
  shortfall_days: number | null;
  slack_days: number | null;
  verdict: FeasibilityVerdict;
  summary: string;
}

export function computeFeasibility(input: CheckTripFeasibilityInput): FeasibilityResult {
  const total_driving_days = input.segment_drive_days.reduce((a, b) => a + b, 0);
  const total_overnight_nights = input.waypoint_nights.reduce((a, b) => a + b, 0);
  const buffer_days = input.buffer_days ?? 0;
  const total_min_days_needed = total_driving_days + total_overnight_nights + buffer_days;

  if (input.time_budget_days == null) {
    return {
      feasible: true,
      total_driving_days,
      total_overnight_nights,
      buffer_days,
      total_min_days_needed,
      budget_days: null,
      shortfall_days: null,
      slack_days: null,
      verdict: 'no_budget',
      summary: `${total_driving_days} driving days + ${total_overnight_nights} overnight nights${
        buffer_days > 0 ? ` + ${buffer_days} buffer` : ''
      } = ${total_min_days_needed} days. No budget set — proceed.`,
    };
  }

  const budget = input.time_budget_days;
  const diff = budget - total_min_days_needed;

  // 'tight' = within 0 days of budget (zero slack). 'fits' = positive slack.
  // We deliberately don't add a "tight" warning band wider than 0 because
  // that's policy — Penny can decide to advise more buffer in her response.
  let verdict: FeasibilityVerdict;
  if (diff < 0) {
    verdict = 'over_budget';
  } else if (diff === 0) {
    verdict = 'tight';
  } else {
    verdict = 'fits';
  }

  const shortfall_days = diff < 0 ? -diff : null;
  const slack_days = diff >= 0 ? diff : null;

  let summary: string;
  if (verdict === 'over_budget') {
    summary = `OVER BUDGET: ${total_min_days_needed} days needed, ${budget} days allowed (short by ${shortfall_days}). Stop and ask the user to extend the trip or drop a stop. Do NOT call add_leg.`;
  } else if (verdict === 'tight') {
    summary = `Tight fit: ${total_min_days_needed} days needed, ${budget} days allowed (zero slack). Proceed but mention the lack of buffer in your response.`;
  } else {
    summary = `Fits: ${total_min_days_needed} days needed, ${budget} days allowed (${slack_days} days slack). Proceed with add_leg.`;
  }

  return {
    feasible: verdict !== 'over_budget',
    total_driving_days,
    total_overnight_nights,
    buffer_days,
    total_min_days_needed,
    budget_days: budget,
    shortfall_days,
    slack_days,
    verdict,
    summary,
  };
}
