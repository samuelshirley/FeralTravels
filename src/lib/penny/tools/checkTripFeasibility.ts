import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  allocateDaysToFlexible,
  type DayModelConfig,
  type DayAllocationResult,
  DEFAULT_DAY_MODEL_CONFIG,
} from '@/lib/dayModel';

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
   * One entry per mandatory TRANSIT waypoint, in route order. Source:
   * nights field from each waypoint in extract_trip_intent's parsed
   * output, EXCLUDING the final destination.
   *
   * These are stops along the way where the driver pauses before
   * continuing (e.g. 2 nights in Innsbruck en route to Bad Kissingen).
   * The final destination's nights do NOT belong here — they happen
   * AFTER arrival and don't affect transit feasibility.
   *
   * Empty array is legal (an A→B trip with no overnight stops).
   * Per-waypoint cap of 30 nights matches the extract_trip_intent cap.
   */
  waypoint_nights: z.array(z.number().int().min(0).max(30)).max(50),

  /**
   * Nights at the final destination. These are NOT counted against the
   * transit budget — they happen after arrival. Tracked here for
   * informational display but excluded from the feasibility formula.
   * Null or 0 when the user didn't specify a stay at the destination.
   */
  destination_nights: z.number().int().min(0).max(60).nullable().optional().default(null),

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

  /**
   * Per-leg time constraints to validate. Each maps to a specific leg in the
   * plan. The server checks whether the cumulative drive time + rest time to
   * reach each constrained leg is compatible with the constraint datetime.
   *
   * Optional — omit if the user set no constraints.
   */
  constraint_checks: z.array(z.object({
    /** Human-readable label for this constraint (e.g. "Arrive Bad Kissingen by Jun 3"). */
    label: z.string(),
    /** Which leg index (0-based in the planned order) this constraint applies to. */
    leg_index: z.number().int().min(0),
    constraint_type: z.enum(['arrive_by', 'depart_after']),
    /** ISO 8601 datetime with timezone. */
    datetime: z.string(),
    /** Buffer minutes. */
    buffer_minutes: z.number().int().min(0).max(1440).optional().default(60),
    /**
     * Cumulative drive time in minutes from trip start to this leg's destination.
     * Penny computes this by summing drive_time_minutes from get_route results.
     */
    cumulative_drive_minutes: z.number().int().min(0),
    /**
     * Cumulative rest/overnight days before this leg (count of rest legs + waypoint nights).
     */
    cumulative_rest_days: z.number().int().min(0),
    /** Planned departure datetime (ISO 8601) — when the user expects to start the trip. */
    departure_datetime: z.string(),
  })).max(20).optional().default([]),

  // ── Day-model-aware allocation (optional, new) ──────────────────────────
  // When present, the server runs the day model to compute optimal night
  // allocation for flexible waypoints given hard deadlines. This replaces
  // Penny's guesswork with deterministic clock-time math.

  /**
   * Flexible waypoints that can absorb extra days. One entry per TRANSIT
   * waypoint that doesn't have a hard deadline. Order matches waypoint_nights.
   * When present, the server computes recommended_nights for each.
   */
  flexible_waypoints: z.array(z.object({
    name: z.string(),
    /** Minimum acceptable nights (user would be disappointed with fewer). */
    min_nights: z.number().int().min(0).max(30),
    /** Preferred nights from the user's stated intent. */
    preferred_nights: z.number().int().min(0).max(30),
  })).max(50).optional(),

  /**
   * The hard deadline for the trip's final arrival. When present alongside
   * flexible_waypoints, enables day-model allocation. Only the final
   * arrive_by constraint needs to go here — earlier constraints are still
   * validated via constraint_checks above.
   */
  arrival_deadline: z.object({
    /** ISO 8601 datetime with timezone. */
    datetime: z.string(),
    /** "HH:MM" in local time — for same-day arrival clock math. */
    local_time: z.string(),
    /** Buffer minutes before deadline. Default 60. */
    buffer_minutes: z.number().int().min(0).max(1440).optional().default(60),
  }).optional(),

  /**
   * Pure driving minutes for the FINAL segment (the one arriving at the
   * deadline destination). Required when arrival_deadline is set — used
   * for same-day arrival feasibility check.
   */
  final_segment_drive_minutes: z.number().int().min(0).optional(),

  /**
   * Per-segment driving minutes, in route order. One entry per segment
   * between waypoints. Required when flexible_waypoints is set. These are
   * the raw drive_time_minutes from get_route (not drive days).
   */
  segment_drive_minutes: z.array(z.number().int().min(0)).max(200).optional(),

  /** ISO date "YYYY-MM-DD" when the trip starts. Required for day model allocation. */
  departure_date: z.string().optional(),
});

export type CheckTripFeasibilityInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: CHECK_TRIP_FEASIBILITY,
  description:
    'Run the deterministic feasibility check on a multi-segment trip. Call this AFTER extract_trip_intent and AFTER you have called get_route for every segment, BEFORE any add_leg. Pass min_driving_days from each get_route result (in route order) as segment_drive_days, and the nights field from each TRANSIT waypoint (EXCLUDING the final destination) as waypoint_nights. Pass the final destination\'s nights separately as destination_nights — these are NOT counted against the transit budget because they happen after arrival. The server does the math and returns a verdict. If verdict is "over_budget", adjust the plan yourself (reduce waypoint nights or drop a waypoint), then call extract_trip_intent with revised numbers and re-run this check — do NOT call add_leg until this check passes. Only ask the user if adjustments alone cannot make it fit. The dispatcher will reject add_leg actions if this check did not pass.\n\nDAY MODEL ALLOCATION: When the user has a hard deadline (arrive_by constraint with a specific time), ALSO pass flexible_waypoints, arrival_deadline, departure_date, segment_drive_minutes, and final_segment_drive_minutes. The server runs clock-time math to determine: (1) whether same-day arrival is feasible (e.g. "can I drive 5h and arrive before 3pm?"), and (2) the optimal night allocation for flexible waypoints. When recommended_allocation is present in the result, USE IT — the server\'s recommended_nights replace whatever you originally proposed in waypoint_nights. This prevents wasting days as buffer when same-day arrival is feasible.',
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
          'nights from each TRANSIT waypoint in extract_trip_intent, in route order. EXCLUDE the final destination\'s nights — those happen after arrival and don\'t affect transit feasibility. Empty array if no mandatory overnight stops along the way.',
      },
      destination_nights: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 60,
        description:
          'Nights the user plans to stay at the FINAL destination. These are excluded from the transit budget calculation but shown in the summary for completeness. Use null or 0 if the user didn\'t specify a destination stay.',
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
      constraint_checks: {
        type: 'array',
        description:
          'Per-leg time constraints to validate. Omit if the user set no constraints. The server checks whether cumulative travel time is compatible with each constraint.',
        items: {
          type: 'object',
          required: ['label', 'leg_index', 'constraint_type', 'datetime', 'cumulative_drive_minutes', 'cumulative_rest_days', 'departure_datetime'],
          properties: {
            label: { type: 'string', description: 'Human-readable label, e.g. "Arrive Bad Kissingen by Jun 3".' },
            leg_index: { type: 'integer', minimum: 0, description: '0-based index of the constrained leg.' },
            constraint_type: { type: 'string', enum: ['arrive_by', 'depart_after'] },
            datetime: { type: 'string', description: 'ISO 8601 datetime with timezone.' },
            buffer_minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Buffer minutes. Default 60.' },
            cumulative_drive_minutes: { type: 'integer', minimum: 0, description: 'Sum of drive_time_minutes from trip start to this leg.' },
            cumulative_rest_days: { type: 'integer', minimum: 0, description: 'Rest/overnight days before this leg.' },
            departure_datetime: { type: 'string', description: 'Planned trip departure datetime (ISO 8601).' },
          },
        },
      },
      // ── Day model allocation fields (optional) ──
      flexible_waypoints: {
        type: 'array',
        description:
          'Flexible waypoints that can absorb extra days. Pass this when the user has a hard deadline (arrive_by with a time) AND flexible waypoints along the route. One entry per TRANSIT waypoint without a hard deadline, in route order matching waypoint_nights.',
        items: {
          type: 'object',
          required: ['name', 'min_nights', 'preferred_nights'],
          properties: {
            name: { type: 'string', description: 'Waypoint name.' },
            min_nights: { type: 'integer', minimum: 0, maximum: 30, description: 'Minimum acceptable nights.' },
            preferred_nights: { type: 'integer', minimum: 0, maximum: 30, description: 'Preferred nights from user intent.' },
          },
        },
      },
      arrival_deadline: {
        type: 'object',
        description:
          'The final arrive_by deadline with a specific time. Required for day model allocation alongside flexible_waypoints.',
        required: ['datetime', 'local_time'],
        properties: {
          datetime: { type: 'string', description: 'ISO 8601 datetime with timezone, e.g. "2026-06-03T15:00:00+02:00".' },
          local_time: { type: 'string', description: '"HH:MM" in local time for clock math, e.g. "15:00".' },
          buffer_minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Buffer minutes. Default 60.' },
        },
      },
      final_segment_drive_minutes: {
        type: 'integer',
        minimum: 0,
        description: 'Pure driving minutes for the final segment (arriving at the deadline). From get_route drive_time_minutes.',
      },
      segment_drive_minutes: {
        type: 'array',
        items: { type: 'integer', minimum: 0 },
        description: 'Per-segment drive_time_minutes from get_route, in route order. Required for day model allocation.',
      },
      departure_date: {
        type: 'string',
        description: 'Trip start date as "YYYY-MM-DD". Required for day model allocation.',
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

export interface ConstraintCheckResult {
  label: string;
  leg_index: number;
  constraint_type: 'arrive_by' | 'depart_after';
  status: 'pass' | 'at_risk' | 'fail';
  /** Human-readable explanation. */
  detail: string;
}

export interface RecommendedAllocation {
  /** Recommended nights per flexible waypoint (same order as input). */
  recommended_nights: number[];
  /** Total trip days with the recommended allocation. */
  total_days: number;
  /** Whether same-day arrival at the deadline is feasible. */
  same_day_arrival: boolean;
  /** Estimated arrival "HH:MM" on the final driving day. */
  arrival_time: string | null;
  /** Minutes of slack before deadline (if same-day). */
  slack_minutes: number | null;
  /** Human-readable explanation for Penny to relay. */
  explanation: string;
}

export interface FeasibilityResult {
  feasible: boolean;
  total_driving_days: number;
  /** Nights at TRANSIT waypoints (counted toward budget). */
  total_transit_nights: number;
  /** Nights at the FINAL destination (NOT counted toward budget). */
  destination_nights: number;
  buffer_days: number;
  /** Transit days only: driving + transit nights + buffer. */
  total_min_days_needed: number;
  /** Full trip length including destination stay (informational). */
  total_trip_days: number;
  budget_days: number | null;
  shortfall_days: number | null;
  slack_days: number | null;
  verdict: FeasibilityVerdict;
  summary: string;
  /** Per-constraint validation results. Empty if no constraints were checked. */
  constraint_results: ConstraintCheckResult[];
  /**
   * Day-model-aware recommended allocation for flexible waypoints.
   * Present only when flexible_waypoints + arrival_deadline were provided.
   * When present, Penny MUST use recommended_nights instead of the
   * waypoint_nights she originally proposed — the server's clock-time math
   * is more accurate than LLM arithmetic.
   */
  recommended_allocation: RecommendedAllocation | null;
}

/**
 * Check per-constraint feasibility. For arrive_by constraints, computes
 * estimated arrival time from departure + cumulative drive + rest days,
 * and compares against the constraint datetime minus buffer.
 */
function checkConstraints(
  checks: CheckTripFeasibilityInput['constraint_checks'],
): ConstraintCheckResult[] {
  if (!checks || checks.length === 0) return [];

  return checks.map((c) => {
    const departure = new Date(c.departure_datetime);
    if (isNaN(departure.getTime())) {
      return { label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type, status: 'fail' as const, detail: 'Invalid departure_datetime.' };
    }

    const constraintTime = new Date(c.datetime);
    if (isNaN(constraintTime.getTime())) {
      return { label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type, status: 'fail' as const, detail: 'Invalid constraint datetime.' };
    }

    const bufferMs = (c.buffer_minutes ?? 60) * 60 * 1000;

    if (c.constraint_type === 'arrive_by') {
      // Estimated arrival = departure + cumulative drive time + rest days (as 24h each)
      const driveMs = c.cumulative_drive_minutes * 60 * 1000;
      const restMs = c.cumulative_rest_days * 24 * 60 * 60 * 1000;
      const estimatedArrival = new Date(departure.getTime() + driveMs + restMs);
      const deadline = new Date(constraintTime.getTime() - bufferMs);

      const slackMs = deadline.getTime() - estimatedArrival.getTime();
      const slackHours = Math.round(slackMs / (60 * 60 * 1000));

      if (slackMs < 0) {
        return {
          label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type,
          status: 'fail',
          detail: `Estimated arrival is ${Math.abs(slackHours)}h after the deadline (with ${c.buffer_minutes ?? 60}min buffer). Needs schedule adjustment.`,
        };
      } else if (slackMs < 4 * 60 * 60 * 1000) {
        // Less than 4 hours slack — at risk
        return {
          label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type,
          status: 'at_risk',
          detail: `Tight — only ${slackHours}h of slack before the deadline. Any delays could make this impossible.`,
        };
      } else {
        return {
          label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type,
          status: 'pass',
          detail: `On track — ${slackHours}h of slack before deadline.`,
        };
      }
    }

    // depart_after: just informational — Penny shouldn't schedule departure before this time
    return {
      label: c.label, leg_index: c.leg_index, constraint_type: c.constraint_type,
      status: 'pass',
      detail: `depart_after constraint noted — Penny should not schedule departure before ${c.datetime}.`,
    };
  });
}

/**
 * Day model config for transit legs: lighter breaks, no camp setup.
 * When driving to an appointment or deadline, you're not pitching a
 * tent — you park and walk in. Breaks are shorter because you're
 * grinding, not sightseeing.
 */
const TRANSIT_DAY_MODEL_CONFIG: DayModelConfig = {
  typicalDepartureTime: '08:00',
  breakMinutesPerDriveHour: 7,
  setupTeardownMinutes: 0,
};

/**
 * Run the day model allocation when Penny provides flexible_waypoints
 * + arrival_deadline. Returns null when the inputs aren't present
 * (backward compat — existing calls without these fields behave
 * exactly as before).
 */
function computeRecommendedAllocation(
  input: CheckTripFeasibilityInput,
): RecommendedAllocation | null {
  if (!input.flexible_waypoints || !input.arrival_deadline || !input.departure_date) {
    return null;
  }

  const finalDriveMin = input.final_segment_drive_minutes ?? 0;

  const allocationResult = allocateDaysToFlexible({
    departureDate: input.departure_date,
    segments: input.segment_drive_days.map((driveDays, i) => ({
      driveMinutes: input.segment_drive_minutes?.[i] ?? 0,
      driveDays,
    })),
    flexibleWaypoints: input.flexible_waypoints.map((w) => ({
      name: w.name,
      minNights: w.min_nights,
      preferredNights: w.preferred_nights,
    })),
    deadline: {
      datetime: input.arrival_deadline.datetime,
      localTime: input.arrival_deadline.local_time,
      bufferMinutes: input.arrival_deadline.buffer_minutes ?? 60,
    },
    finalSegmentDriveMinutes: finalDriveMin,
    config: TRANSIT_DAY_MODEL_CONFIG,
  });

  return {
    recommended_nights: allocationResult.allocatedNights,
    total_days: allocationResult.totalDays,
    same_day_arrival: allocationResult.sameDayArrival,
    arrival_time: allocationResult.sameDayArrival
      ? allocationResult.arrivalDate
      : null,
    slack_minutes: allocationResult.slackMinutes,
    explanation: allocationResult.explanation,
  };
}

export function computeFeasibility(input: CheckTripFeasibilityInput): FeasibilityResult {
  const total_driving_days = input.segment_drive_days.reduce((a, b) => a + b, 0);
  const total_transit_nights = input.waypoint_nights.reduce((a, b) => a + b, 0);
  const destination_nights = input.destination_nights ?? 0;
  const buffer_days = input.buffer_days ?? 0;

  // Transit budget: only driving days + transit stop nights + buffer.
  // Destination nights happen AFTER arrival and don't affect "can I get there?"
  const total_min_days_needed = total_driving_days + total_transit_nights + buffer_days;

  // Full trip length for informational display.
  const total_trip_days = total_min_days_needed + destination_nights;

  // Per-constraint validation
  const constraint_results = checkConstraints(input.constraint_checks);
  const anyConstraintFailed = constraint_results.some((r) => r.status === 'fail');

  // Day-model-aware allocation (optional — only when new fields are present)
  const recommended_allocation = computeRecommendedAllocation(input);

  if (input.time_budget_days == null) {
    const destNote = destination_nights > 0
      ? ` + ${destination_nights} nights at destination`
      : '';
    const constraintNote = constraint_results.length > 0
      ? ` Constraints: ${constraint_results.filter(r => r.status === 'fail').length} failed, ${constraint_results.filter(r => r.status === 'at_risk').length} at risk, ${constraint_results.filter(r => r.status === 'pass').length} pass.`
      : '';
    const allocNote = recommended_allocation
      ? ` RECOMMENDED ALLOCATION: ${recommended_allocation.explanation}`
      : '';
    return {
      feasible: !anyConstraintFailed,
      total_driving_days,
      total_transit_nights,
      destination_nights,
      buffer_days,
      total_min_days_needed,
      total_trip_days,
      budget_days: null,
      shortfall_days: null,
      slack_days: null,
      verdict: 'no_budget',
      summary: `Transit: ${total_driving_days} driving days + ${total_transit_nights} transit nights${
        buffer_days > 0 ? ` + ${buffer_days} buffer` : ''
      } = ${total_min_days_needed} days to arrive${destNote} (${total_trip_days} total trip days). No budget set.${constraintNote}${allocNote}`,
      constraint_results,
      recommended_allocation,
    };
  }

  const budget = input.time_budget_days;
  const diff = budget - total_min_days_needed;

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
  const destNote = destination_nights > 0
    ? ` Then ${destination_nights} nights at the destination (not counted against transit budget).`
    : '';
  const constraintNote = constraint_results.length > 0
    ? ` Constraints: ${constraint_results.filter(r => r.status === 'fail').length} failed, ${constraint_results.filter(r => r.status === 'at_risk').length} at risk, ${constraint_results.filter(r => r.status === 'pass').length} pass.`
    : '';
  const allocNote = recommended_allocation
    ? ` RECOMMENDED ALLOCATION: ${recommended_allocation.explanation}`
    : '';

  let summary: string;
  if (verdict === 'over_budget') {
    summary = `OVER BUDGET: ${total_min_days_needed} transit days needed (${total_driving_days} driving + ${total_transit_nights} transit nights), ${budget} days allowed (short by ${shortfall_days}).${destNote} Adjust the plan to fit: reduce waypoint nights or drop a waypoint, then re-run extract_trip_intent and check_trip_feasibility with the revised numbers. Do NOT call add_leg until this check passes.${constraintNote}${allocNote}`;
  } else if (verdict === 'tight') {
    summary = `Tight fit: ${total_min_days_needed} transit days needed, ${budget} days allowed (zero slack).${destNote} Proceed but mention the lack of buffer in your response.${constraintNote}${allocNote}`;
  } else {
    summary = `Fits: ${total_min_days_needed} transit days needed, ${budget} days allowed (${slack_days} days slack).${destNote} Proceed with add_leg.${constraintNote}${allocNote}`;
  }

  return {
    feasible: verdict !== 'over_budget' && !anyConstraintFailed,
    total_driving_days,
    total_transit_nights,
    destination_nights,
    buffer_days,
    total_min_days_needed,
    total_trip_days,
    budget_days: budget,
    shortfall_days,
    slack_days,
    verdict,
    summary,
    constraint_results,
    recommended_allocation,
  };
}
