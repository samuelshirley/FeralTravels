/**
 * Date formatting helpers — client-safe (no `server-only` import).
 *
 * The DB stores trip start dates as ISO "YYYY-MM-DD" in `start_date_parsed`.
 * Leg dates are derived at render time from the trip start date + the leg's
 * position in the array (each leg = one calendar day).
 *
 * Display format depends on the user's units preference:
 *   metric   → "Wed 28 May"   (day-first, the rest of the world)
 *   imperial → "Wed May 28"   (month-first, the American way)
 *
 * Uses Intl.DateTimeFormat — no external date library needed.
 */

import type { UnitsPref } from './units';

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * Run a non-ISO string through Date.parse and return a local "YYYY-MM-DD".
 *
 * Date.parse treats date-only non-ISO strings ("November 1 2026", "05/28/2026")
 * as LOCAL midnight, so we read the local calendar parts (not UTC) to avoid a
 * timezone day-shift. Rejects years outside a sane window so junk like "1" that
 * Date.parse coerces into year 2001 doesn't slip through.
 */
function parseViaDateParse(s: string): string | null {
  const ms = Date.parse(s);
  if (isNaN(ms)) return null;
  const d = new Date(ms);
  const year = d.getFullYear();
  if (year < 2000 || year > 2100) return null;
  return toISO(d);
}

/**
 * Interpret a relative weekday phrase ("saturday", "next friday", "this mon")
 * as the next upcoming occurrence strictly after `today`. Returns null when the
 * phrase isn't a weekday.
 */
function parseRelativeWeekday(lower: string, today: Date): string | null {
  const cleaned = lower.replace(/^(next|this|on|coming)\s+/, '').trim();
  const idx = WEEKDAYS.findIndex(
    (w) => w === cleaned || w.slice(0, 3) === cleaned,
  );
  if (idx === -1) return null;
  let delta = (idx - today.getDay() + 7) % 7;
  if (delta === 0) delta = 7; // "saturday" said on a Saturday means next week
  return toISO(addDays(today, delta));
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse an explicit "month day" / "day month" with NO year ("November 1",
 * "1 Nov") and resolve the year forward: this year if the day is still ahead of
 * `today`, otherwise next year. Strict on purpose — requires a real month name
 * and a 1–31 day — so Date.parse's leniency (which happily pulls a bare year out
 * of junk and defaults the rest to Jan 1) can't sneak a date through.
 */
function parseMonthDayNoYear(s: string, today: Date): string | null {
  const lower = s.toLowerCase().replace(/,/g, '');
  let monthName: string | undefined;
  let day: number | undefined;

  let m = lower.match(/^([a-z]+)\.?\s+(\d{1,2})$/); // "november 1"
  if (m) {
    monthName = m[1];
    day = +m[2];
  } else {
    m = lower.match(/^(\d{1,2})\s+([a-z]+)\.?$/); // "1 november"
    if (m) {
      day = +m[1];
      monthName = m[2];
    }
  }
  if (monthName === undefined || day === undefined) return null;

  const month = MONTHS[monthName];
  if (month === undefined || day < 1 || day > 31) return null;

  let d = new Date(today.getFullYear(), month, day);
  if (d.getMonth() !== month) return null; // rejects impossible days (e.g. Feb 30)
  if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, day);
  return toISO(d);
}

/**
 * Try to extract an ISO "YYYY-MM-DD" string from a free-text date.
 *
 * Handles the formats people actually type:
 *   - ISO:        "2026-05-28"
 *   - US text:    "May 28, 2026"  /  "May 28 2026"
 *   - EU text:    "28 May 2026"
 *   - Slash:      "05/28/2026"  /  "5/28/2026"
 *   - Ordinals:   "November 1st", "June 3rd 2026"
 *   - No year:    "November 1", "1 Nov" → next future occurrence of that day
 *   - Relative:   "today", "tomorrow", "next Saturday", "friday"
 *
 * `now` is injectable for testing; it anchors the year-inference and relative
 * phrases. Year inference is forward-looking: a month/day with no year resolves
 * to the next occurrence from today (trip start dates are always upcoming), so
 * "January 5" said in May means next January, not the one that just passed.
 *
 * Returns null only when the string genuinely doesn't point to a specific day
 * ("sometime in summer", "may" with no day, garbage).
 */
export function tryParseToISO(
  input: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!input) return null;
  // Strip ordinal suffixes ("1st", "2nd", "23rd") — they break Date.parse.
  const s = input.trim().replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  if (!s) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Already ISO? Validate and return.
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const d = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    if (!isNaN(d.getTime())) return toISO(d);
  }

  // Relative phrases.
  const lower = s.toLowerCase();
  if (lower === 'today') return toISO(today);
  if (lower === 'tomorrow') return toISO(addDays(today, 1));
  const weekday = parseRelativeWeekday(lower, today);
  if (weekday) return weekday;

  // A full date that already carries an explicit year ("May 28 2026",
  // "05/28/2026"). Only trust Date.parse when a 4-digit year is present — it's
  // too eager to invent missing parts otherwise.
  if (/\d{4}/.test(s)) {
    const withExplicitYear = parseViaDateParse(s);
    if (withExplicitYear) return withExplicitYear;
  }

  // Month + day with no year ("November 1", "1 Nov") → next future occurrence.
  return parseMonthDayNoYear(s, today);
}

const MONTH_NAME_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// Date-like substrings to look for inside free prose, most-specific first. Each
// is run through tryParseToISO, so a match still has to parse to a real day.
const DATE_PHRASE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/, // ISO
  new RegExp(`\\b(?:${MONTH_NAME_RE})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'i'), // "November 1st 2026"
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAME_RE})\\.?(?:,?\\s+\\d{4})?\\b`, 'i'), // "1 November 2026"
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // "11/01/2026"
];

/**
 * Pull the first parseable date out of free-text prose (e.g. a trip description
 * like "...started November 1st, from Austin..."). Returns the ISO date or null.
 *
 * Intentionally anchored on explicit date shapes (month names, ISO, slashes) so
 * stray numbers like "spend 2 days" don't register as dates. Because it takes
 * the FIRST date it finds — which may not be the one the user means — callers
 * should treat the result as a suggestion to confirm, not a silent commit.
 */
export function extractDateFromText(
  text: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!text) return null;
  for (const re of DATE_PHRASE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const iso = tryParseToISO(match[0], now);
      if (iso) return iso;
    }
  }
  return null;
}

/** Format a Date as "YYYY-MM-DD". */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's calendar date as ISO "YYYY-MM-DD" in the runtime's local timezone. */
export function todayISO(): string {
  return toISO(new Date());
}

/**
 * Decide how many leading legs are "behind" the driver — the cutoff index used
 * to tuck completed/past days into the collapsible "behind you" section so the
 * itinerary opens at today rather than at a day that has already passed.
 *
 * Returns the rank of the first still-ahead leg: 0 means nothing is behind,
 * `legDateISOs.length` means the whole trip is behind.
 *
 * Precedence:
 *   1. An explicit driver position report (`reportedRank >= 0`) always wins.
 *      `reportPosition` re-anchors the calendar so the reported leg IS today,
 *      and a deliberate "I'm here" beats any date heuristic.
 *   2. Otherwise fall back to the calendar: every leg dated strictly before
 *      `todayISO` is behind you; "ahead" begins at the first leg dated
 *      today-or-later. Leg dates are a hard invariant (see Leg.date_iso), so
 *      every leg has one. ISO "YYYY-MM-DD" strings compare lexicographically.
 *
 * Guard: if every leg is in the past (trip fully elapsed), we keep the last leg
 * visible so the main list is never empty.
 */
export function behindCutoffRank(args: {
  reportedRank: number;
  legDateISOs: string[];
  todayISO: string;
}): number {
  const { reportedRank, legDateISOs, todayISO } = args;

  // Explicit report wins. Clamp to a sane range.
  if (reportedRank >= 0) {
    return Math.min(Math.max(reportedRank, 0), legDateISOs.length);
  }

  // Collapse every leg dated strictly before today.
  let cutoff = 0;
  while (cutoff < legDateISOs.length && legDateISOs[cutoff] < todayISO) {
    cutoff++;
  }

  // If every leg is in the past (trip fully elapsed), keep the last leg visible
  // so the main list is never empty.
  if (cutoff === legDateISOs.length && cutoff > 0) {
    return cutoff - 1;
  }
  return cutoff;
}

/**
 * Parse an ISO "YYYY-MM-DD" string into a local-midnight Date without
 * timezone shift. `new Date("2026-05-28")` parses as UTC midnight which
 * can roll back a day in negative-offset timezones — avoid that.
 */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Add `days` calendar days to a Date (returns a new Date).
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Format a Date for display based on the user's unit preference.
 *
 *   metric   → "Wed 28 May"
 *   imperial → "Wed May 28"
 *
 * Uses Intl.DateTimeFormat.formatToParts for precise control over order,
 * stripping any commas Intl wants to insert.
 */
export function formatDate(date: Date, units: UnitsPref): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';

  if (units === 'imperial') {
    return `${weekday} ${month} ${day}`;
  }
  return `${weekday} ${day} ${month}`;
}

// ---------------------------------------------------------------------------
// Domain logic: calendar-date assignment + constraint scheduling.
//
// These are pure functions (no I/O, no `server-only`) so they can be unit
// tested and shared between the server (date assignment, feasibility,
// dispatch enforcement) and — for display formatting only — the client.
//
// THE DATE MODEL: every leg (driving OR rest) occupies exactly one calendar
// day. A leg's date is therefore `trip.start_date_parsed + its 0-based rank`
// in the sort_order-sorted leg list. Rest-day legs are the only lever that
// shifts a later leg's date without adding driving — which is why honoring a
// fixed date ("leave on the 3rd") reduces to inserting the right number of
// rest legs before the anchored leg.
// ---------------------------------------------------------------------------

/**
 * The ISO "YYYY-MM-DD" calendar date a leg falls on, given the trip start date
 * and the leg's 0-based rank in the sorted leg list. This is the server-side
 * source of truth for leg dates; the client formats the result.
 *
 * `tripStartISO` is non-null by contract — the trip start date is a hard
 * invariant (see Trip.start_date_parsed) and every other caller passes a date
 * already validated upstream.
 */
export function legDateISO(tripStartISO: string, legIndex: number): string {
  const start = parseISODate(tripStartISO);
  return toISO(addDays(start, legIndex));
}

/**
 * Whole calendar days from `fromISO` to `toISO` (i.e. `to - from`). Negative
 * when `to` precedes `from`. Both inputs are "YYYY-MM-DD". Returns null when
 * either side can't be parsed.
 */
export function daysBetweenISO(
  fromISO: string | null | undefined,
  toISO: string | null | undefined,
): number | null {
  if (!fromISO || !toISO) return null;
  const a = parseISODate(fromISO);
  const b = parseISODate(toISO);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  // Both are local-midnight dates, so a plain ms difference is exact.
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Extract the *local* calendar date ("YYYY-MM-DD") from a constraint datetime.
 *
 * Constraint datetimes are authored as ISO 8601 with an explicit offset, e.g.
 * "2026-06-03T08:00:00+02:00". The local date is the calendar day the user
 * means ("the morning of the 3rd"), so we take the date prefix directly rather
 * than routing through `new Date()` — which would convert to the runtime's
 * timezone and can roll the day backward/forward.
 *
 * Falls back to {@link tryParseToISO} for looser inputs ("June 3, 2026").
 */
export function constraintLocalDateISO(
  datetime: string | null | undefined,
): string | null {
  if (!datetime) return null;
  const trimmed = datetime.trim();
  const prefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (prefix) {
    const iso = `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
    // Validate it's a real date.
    const d = parseISODate(iso);
    if (!isNaN(d.getTime())) return iso;
  }
  return tryParseToISO(trimmed);
}

/**
 * Extract the *local* wall-clock time ("HH:MM") from a constraint datetime.
 *
 * Constraint datetimes are authored as ISO 8601 with an explicit offset, e.g.
 * "2026-06-03T15:00:00+02:00" — the local time is "the morning/afternoon the
 * user means" ("by 3pm"), so we read the HH:MM directly from the string rather
 * than via `new Date()`, which would convert to the runtime's timezone. Returns
 * null when there's no time component (date-only constraints).
 */
export function constraintLocalTimeHHMM(
  datetime: string | null | undefined,
): string | null {
  if (!datetime) return null;
  const m = datetime.trim().match(/[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/**
 * Given a fixed calendar date that a specific leg must fall on, compute how
 * many rest-day legs must sit *before* that leg.
 *
 * The anchored leg's required rank = (targetDate − tripStart) in days. Of the
 * legs before it, `driveDaysBefore` are immovable driving days (fixed by the
 * route), so the remaining slots must be rest days:
 *
 *   requiredRestDaysBefore = (targetDate − tripStart) − driveDaysBefore
 *
 * A negative result means the date is physically too early — the driving
 * alone overruns it — i.e. genuinely infeasible. Returns null when inputs
 * can't be parsed.
 */
export function requiredRestDaysBefore(args: {
  tripStartISO: string | null | undefined;
  targetDateISO: string | null | undefined;
  driveDaysBefore: number;
}): number | null {
  const span = daysBetweenISO(args.tripStartISO, args.targetDateISO);
  if (span == null) return null;
  return span - args.driveDaysBefore;
}
