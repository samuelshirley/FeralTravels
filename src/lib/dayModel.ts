/**
 * dayModel.ts — Deterministic clock-time math for human travel days.
 *
 * The old planning model treated driving as abstract duration blocks:
 * "5 hours of driving = 1 day". It had no concept of WHEN in the day
 * you drive, so it couldn't answer "can I leave at 8am and arrive
 * before 3pm?" This module fills that gap.
 *
 * Every function here is pure computation — no I/O, no DB, no LLM.
 * Inputs are numbers and strings; outputs are deterministic results.
 *
 * Key concepts:
 *
 *   DEFINED goal  — specific date + time + place (e.g. "June 3 at 3pm
 *                   in Bad Kissingen"). Non-negotiable. Plan works
 *                   backwards from these.
 *
 *   ARBITRARY goal — flexible, no hard deadline (e.g. "a few days in
 *                    Innsbruck"). Gets all remaining days after defined
 *                    goals are satisfied.
 *
 *   TRANSIT leg   — pure ground-covering. User doesn't care about the
 *                   drive, just getting there. Uses transit_max_hours.
 *
 *   CRUISE leg    — the drive IS the experience. User wants stops,
 *                   scenery, short days. Uses cruise_max_hours.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DayModelConfig {
  /** When the driver typically starts driving, e.g. "08:00". */
  typicalDepartureTime: string;
  /** Minutes of break per hour of driving. Default 10 (10min/hr). */
  breakMinutesPerDriveHour: number;
  /** Morning pack-up / evening setup overhead in minutes. Default 30. */
  setupTeardownMinutes: number;
}

export const DEFAULT_DAY_MODEL_CONFIG: DayModelConfig = {
  typicalDepartureTime: '08:00',
  breakMinutesPerDriveHour: 10,
  setupTeardownMinutes: 30,
};

// ---------------------------------------------------------------------------
// Time helpers (pure, no Date objects with timezone foot-guns)
// ---------------------------------------------------------------------------

/** Minutes since midnight from "HH:MM" string. */
export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  if (h == null || m == null || isNaN(h) || isNaN(m)) {
    throw new Error(`Invalid time string: "${time}"`);
  }
  return h * 60 + m;
}

/** "HH:MM" from minutes since midnight. Handles >24h by wrapping. */
export function minutesToTime(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.round(wrapped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Core: compute wall-clock arrival time
// ---------------------------------------------------------------------------

export interface ArrivalTimeResult {
  /** "HH:MM" arrival time. */
  arrivalTime: string;
  /** Total minutes from departure to arrival (drive + breaks + setup). */
  totalElapsedMinutes: number;
  /** Minutes of breaks included. */
  breakMinutes: number;
  /** Whether arrival is on the same calendar day as departure. */
  sameDay: boolean;
}

/**
 * Given a departure time and pure driving duration, compute the
 * wall-clock arrival time including realistic breaks.
 *
 * This models a real human day: you leave at 8am, drive for a while,
 * stop for fuel/food/stretch, and arrive sometime later. The break
 * cadence is configurable but defaults to 10 min per hour of driving
 * (roughly a 15-min stop every 1.5h, which is realistic for
 * overlanders hauling a rig).
 */
export function computeArrivalTime(
  driveMinutes: number,
  config: DayModelConfig = DEFAULT_DAY_MODEL_CONFIG,
): ArrivalTimeResult {
  const departureMin = parseTimeToMinutes(config.typicalDepartureTime);
  const breakMinutes = Math.round(
    (driveMinutes / 60) * config.breakMinutesPerDriveHour,
  );
  // Setup/teardown is for packing up camp in the morning — already
  // baked into departure time for the "leave at 8am" default, but if
  // the user's departure time is "when I wake up" we'd add it. For
  // now, arrival includes setup at the destination end.
  const totalElapsed = driveMinutes + breakMinutes + config.setupTeardownMinutes;
  const arrivalMin = departureMin + totalElapsed;
  const sameDay = arrivalMin < 1440; // less than 24h from midnight

  return {
    arrivalTime: minutesToTime(arrivalMin),
    totalElapsedMinutes: totalElapsed,
    breakMinutes,
    sameDay,
  };
}

// ---------------------------------------------------------------------------
// Can I make a deadline if I drive that morning?
// ---------------------------------------------------------------------------

export interface SameDayFeasibility {
  /** Whether arrival is before the deadline with buffer. */
  feasible: boolean;
  /** Estimated arrival "HH:MM". */
  arrivalTime: string;
  /** Minutes of slack between arrival and deadline (negative = late). */
  slackMinutes: number;
  /** Total wall-clock minutes the driving day takes. */
  totalElapsedMinutes: number;
}

/**
 * "Can I leave in the morning, drive this leg, and arrive before my
 * deadline with a 1-hour buffer?"
 *
 * This is the function that would have prevented the Bad Kissingen
 * problem. Penny gave a 1-day buffer because she couldn't do this
 * math. Now we can.
 *
 * @param driveMinutes  Pure driving time for the leg (no breaks).
 * @param deadlineTime  "HH:MM" deadline on the arrival day.
 * @param bufferMinutes Desired slack before deadline. Default 60.
 * @param config        Day model config (departure time, break cadence).
 */
export function canArriveSameDay(
  driveMinutes: number,
  deadlineTime: string,
  bufferMinutes: number = 60,
  config: DayModelConfig = DEFAULT_DAY_MODEL_CONFIG,
): SameDayFeasibility {
  const arrival = computeArrivalTime(driveMinutes, config);
  const deadlineMin = parseTimeToMinutes(deadlineTime);
  const arrivalMin = parseTimeToMinutes(arrival.arrivalTime);

  // If arrival spills to next day, it's not same-day feasible
  if (!arrival.sameDay) {
    return {
      feasible: false,
      arrivalTime: arrival.arrivalTime,
      slackMinutes: -(arrivalMin + 1440 - deadlineMin + bufferMinutes),
      totalElapsedMinutes: arrival.totalElapsedMinutes,
    };
  }

  const slackMinutes = deadlineMin - arrivalMin - bufferMinutes;
  return {
    feasible: slackMinutes >= 0,
    arrivalTime: arrival.arrivalTime,
    slackMinutes,
    totalElapsedMinutes: arrival.totalElapsedMinutes,
  };
}

// ---------------------------------------------------------------------------
// Allocate days to flexible waypoints given a fixed deadline
// ---------------------------------------------------------------------------

export interface DayAllocationInput {
  /** Date the trip departs, ISO date string "YYYY-MM-DD". */
  departureDate: string;
  /**
   * Segments between waypoints, in route order. Each has the pure
   * driving time and whether it's a transit leg (grind) or cruise
   * (experience). Transit legs can use the higher drive cap.
   */
  segments: Array<{
    driveMinutes: number;
    /** How many driving days this segment needs (from get_route). */
    driveDays: number;
  }>;
  /**
   * Flexible waypoints with a range of acceptable nights. These sit
   * BETWEEN segments (waypoint[i] is between segment[i] and segment[i+1]).
   */
  flexibleWaypoints: Array<{
    name: string;
    /** Minimum nights the user would accept (often 1). */
    minNights: number;
    /** Maximum nights they'd ideally want (from their stated intent). */
    preferredNights: number;
  }>;
  /**
   * The hard deadline — a defined goal at the end of the trip.
   * If null, there's no deadline and we just use preferred nights.
   */
  deadline: {
    /** ISO datetime string, e.g. "2026-06-03T15:00:00+02:00". */
    datetime: string;
    /** "HH:MM" in local time for same-day arrival check. */
    localTime: string;
    /** Buffer minutes before deadline. Default 60. */
    bufferMinutes?: number;
  } | null;
  /**
   * Drive minutes of the FINAL segment (the one arriving at the
   * deadline destination). Used to check same-day arrival feasibility.
   */
  finalSegmentDriveMinutes: number;
  /** Day model config. */
  config?: DayModelConfig;
}

export interface DayAllocationResult {
  /**
   * Allocated nights per flexible waypoint (same order as input).
   * Each value is between minNights and preferredNights.
   */
  allocatedNights: number[];
  /** Total trip days (driving + all waypoint nights). */
  totalDays: number;
  /** Whether same-day arrival at the deadline is feasible. */
  sameDayArrival: boolean;
  /**
   * Arrival day as ISO date string. If sameDayArrival is true, this
   * is the deadline day. Otherwise it's the day before.
   */
  arrivalDate: string;
  /** Slack minutes if same-day, or null if arriving day before. */
  slackMinutes: number | null;
  /** Explanation of the allocation logic for debugging / Penny's context. */
  explanation: string;
}

/**
 * Given a departure date, driving segments, flexible waypoints, and an
 * optional hard deadline, figure out how many nights each flexible
 * waypoint gets.
 *
 * Strategy: work backwards from the deadline.
 *   1. Check if the final leg can arrive same-day (using day model).
 *   2. If yes: the driving day IS the deadline day. All remaining
 *      calendar days between departure and deadline go to flex waypoints.
 *   3. Distribute available days to flex waypoints proportionally
 *      to their preferred nights, respecting minimums.
 *
 * This is the function that turns "arrive June 3 at 3pm" + "a few
 * days in Innsbruck" into "4 rest days in Innsbruck, drive morning
 * of June 3, arrive 1:15pm."
 */
export function allocateDaysToFlexible(
  input: DayAllocationInput,
): DayAllocationResult {
  const config = input.config ?? DEFAULT_DAY_MODEL_CONFIG;

  // No deadline → just use preferred nights for everything
  if (!input.deadline) {
    const allocatedNights = input.flexibleWaypoints.map((w) => w.preferredNights);
    const totalDriveDays = input.segments.reduce((sum, s) => sum + s.driveDays, 0);
    const totalFlexNights = allocatedNights.reduce((sum, n) => sum + n, 0);
    return {
      allocatedNights,
      totalDays: totalDriveDays + totalFlexNights,
      sameDayArrival: false,
      arrivalDate: '',
      slackMinutes: null,
      explanation: 'No deadline — using preferred nights for all waypoints.',
    };
  }

  // Parse deadline date
  const deadlineDate = new Date(input.deadline.datetime);
  const departureDateObj = new Date(input.departureDate + 'T00:00:00');

  // Total calendar days available (departure day = day 1)
  const totalCalendarDays = Math.floor(
    (deadlineDate.getTime() - departureDateObj.getTime()) / (24 * 60 * 60 * 1000),
  );

  // Check same-day arrival feasibility
  const sameDayCheck = canArriveSameDay(
    input.finalSegmentDriveMinutes,
    input.deadline.localTime,
    input.deadline.bufferMinutes ?? 60,
    config,
  );

  // Total driving days across all segments
  const totalDriveDays = input.segments.reduce((sum, s) => sum + s.driveDays, 0);

  // If same-day arrival works, the final drive day IS the deadline day.
  // Available flex days = calendar days - driving days.
  // If same-day doesn't work, we need to arrive the day before,
  // which costs us one flex day.
  const sameDayArrival = sameDayCheck.feasible;
  const arrivalDayPenalty = sameDayArrival ? 0 : 1;
  const availableFlexDays = totalCalendarDays - totalDriveDays - arrivalDayPenalty;

  // Minimum flex days needed
  const minFlexDays = input.flexibleWaypoints.reduce((sum, w) => sum + w.minNights, 0);
  // Preferred flex days
  const preferredFlexDays = input.flexibleWaypoints.reduce((sum, w) => sum + w.preferredNights, 0);

  if (availableFlexDays < minFlexDays) {
    // Can't even hit minimums — allocate minimums and flag the shortfall
    const allocatedNights = input.flexibleWaypoints.map((w) => w.minNights);
    const totalFlexNights = allocatedNights.reduce((sum, n) => sum + n, 0);
    return {
      allocatedNights,
      totalDays: totalDriveDays + totalFlexNights + arrivalDayPenalty,
      sameDayArrival,
      arrivalDate: computeArrivalDate(departureDateObj, totalDriveDays + totalFlexNights + arrivalDayPenalty - 1),
      slackMinutes: sameDayArrival ? sameDayCheck.slackMinutes : null,
      explanation: `Tight: only ${availableFlexDays} flex days available but minimums need ${minFlexDays}. Using minimum nights everywhere. ${sameDayArrival ? `Same-day arrival with ${sameDayCheck.slackMinutes}min slack.` : 'Arriving day before deadline.'}`,
    };
  }

  // Distribute available days proportionally to preferred nights
  let allocatedNights: number[];
  if (availableFlexDays >= preferredFlexDays) {
    // Plenty of room — give everyone their preferred amount.
    // Distribute surplus evenly starting from first waypoint.
    allocatedNights = input.flexibleWaypoints.map((w) => w.preferredNights);
    let surplus = availableFlexDays - preferredFlexDays;
    let i = 0;
    while (surplus > 0 && input.flexibleWaypoints.length > 0) {
      allocatedNights[i % allocatedNights.length]++;
      surplus--;
      i++;
    }
  } else {
    // Need to compress — scale down proportionally from preferred,
    // respecting minimums. This is the common case with deadlines.
    allocatedNights = input.flexibleWaypoints.map((w) => w.minNights);
    let remaining = availableFlexDays - minFlexDays;
    // Distribute extra days proportionally to (preferred - min)
    const extras = input.flexibleWaypoints.map((w) => w.preferredNights - w.minNights);
    const totalExtras = extras.reduce((sum, e) => sum + e, 0);

    if (totalExtras > 0) {
      for (let i = 0; i < extras.length && remaining > 0; i++) {
        const share = Math.round((extras[i] / totalExtras) * (availableFlexDays - minFlexDays));
        const capped = Math.min(share, extras[i], remaining);
        allocatedNights[i] += capped;
        remaining -= capped;
      }
      // Distribute any rounding remainder
      let i = 0;
      while (remaining > 0) {
        const idx = i % allocatedNights.length;
        if (allocatedNights[idx] < input.flexibleWaypoints[idx].preferredNights) {
          allocatedNights[idx]++;
          remaining--;
        }
        i++;
        if (i > allocatedNights.length * 2) break; // safety valve
      }
    }
  }

  const totalFlexNights = allocatedNights.reduce((sum, n) => sum + n, 0);
  const totalDays = totalDriveDays + totalFlexNights + arrivalDayPenalty;
  const arrivalDate = computeArrivalDate(departureDateObj, totalDays - 1);

  const waypointSummary = input.flexibleWaypoints
    .map((w, i) => `${w.name}: ${allocatedNights[i]} nights`)
    .join(', ');

  return {
    allocatedNights,
    totalDays,
    sameDayArrival,
    arrivalDate,
    slackMinutes: sameDayArrival ? sameDayCheck.slackMinutes : null,
    explanation: sameDayArrival
      ? `Same-day arrival feasible (arrive ${sameDayCheck.arrivalTime}, ${sameDayCheck.slackMinutes}min before deadline). ${waypointSummary}. ${totalDays} days total.`
      : `Same-day arrival not feasible — arriving day before. ${waypointSummary}. ${totalDays} days total.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeArrivalDate(departure: Date, daysAfter: number): string {
  const d = new Date(departure);
  d.setDate(d.getDate() + daysAfter);
  return d.toISOString().slice(0, 10);
}
