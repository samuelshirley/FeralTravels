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

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Add `months` calendar months, clamping the day to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const y = date.getFullYear();
  const m = date.getMonth() + months;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(targetY, targetM + 1, 0).getDate();
  return new Date(targetY, targetM, Math.min(date.getDate(), lastDay));
}

/**
 * Relative offset phrases: "in 2 weeks", "in 3 days", "in a month", "next week",
 * "next month". Anchored to `today`. Returns null when the phrase isn't one of
 * these shapes.
 */
function parseRelativeOffset(lower: string, today: Date): string | null {
  if (lower === 'next week') return toISO(addDays(today, 7));
  if (lower === 'next month') return toISO(addMonths(today, 1));
  const m = lower.match(
    /^in\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|days|week|weeks|month|months)$/,
  );
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1]];
  if (n === undefined || n < 1 || n > 365) return null;
  const unit = m[2];
  if (unit.startsWith('day')) return toISO(addDays(today, n));
  if (unit.startsWith('week')) return toISO(addDays(today, n * 7));
  return toISO(addMonths(today, n));
}

/**
 * Parse a purely numeric date with separators: "27-6-26", "27/6/2026",
 * "27.06.2026". Two- or four-digit year (2-digit expands to 20xx).
 *
 * Disambiguation: slash defaults to US month-first ("06/03/26" = Jun 3) to match
 * Date.parse's behavior for the slash form; dash and dot default to day-first
 * (the app's display convention — see formatDate). Either way, if one component
 * can only be a day (>12), we use that to fix the order. Genuinely ambiguous
 * cases ("3/6/26") follow the separator default; the LLM fallback handles the
 * rest. Same separator must be used in both positions.
 */
function parseNumericDMY(s: string, _today: Date): string | null {
  const m = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/);
  if (!m) return null;
  const a = +m[1];
  const sep = m[2];
  const b = +m[3];
  let year = +m[4];
  if (m[4].length === 2) year += 2000;
  if (year < 2000 || year > 2100) return null;

  let day: number;
  let month: number;
  if (a > 12 && b <= 12) {
    day = a;
    month = b; // first can't be a month
  } else if (b > 12 && a <= 12) {
    month = a;
    day = b; // second can't be a month
  } else if (sep === '/') {
    month = a; // slash → US month-first
    day = b;
  } else {
    day = a; // dash/dot → European day-first
    month = b;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null; // e.g. 31-02
  return toISO(d);
}

const MONTH_NAME_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// Date-shaped substrings to look for embedded in a longer string (e.g.
// "tomorrow 27-6-26", "leaving 27/6/26"). Anchored on real date shapes so stray
// numbers don't register. Each match is re-run through tryParseToISO.
const EMBEDDED_DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/, // ISO
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/, // numeric d-m-y / d/m/y / d.m.y
  new RegExp(`\\b(?:${MONTH_NAME_RE})\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, 'i'), // "November 1 2026"
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTH_NAME_RE})\\.?(?:,?\\s+\\d{4})?\\b`, 'i'), // "1 November 2026"
];

/**
 * Try to extract an ISO "YYYY-MM-DD" string from a free-text date.
 *
 * Handles the formats people actually type:
 *   - ISO:        "2026-05-28"
 *   - US text:    "May 28, 2026"  /  "May 28 2026"
 *   - EU text:    "28 May 2026"
 *   - Slash:      "05/28/2026"  /  "5/28/2026"
 *   - Numeric:    "27-6-26", "27/6/2026", "27.06.2026" (day-first for dash/dot)
 *   - Ordinals:   "November 1st", "June 3rd 2026"
 *   - No year:    "November 1", "1 Nov" → next future occurrence of that day
 *   - Relative:   "today", "tonight", "tomorrow", "next Saturday", "friday",
 *                 "next week", "in 2 weeks", "in 3 days"
 *   - Combined:   "tomorrow 27-6-26" (embedded date wins), "tomorrow morning"
 *
 * `now` is injectable for testing; it anchors the year-inference and relative
 * phrases. Year inference is forward-looking: a month/day with no year resolves
 * to the next occurrence from today (trip start dates are always upcoming), so
 * "January 5" said in May means next January, not the one that just passed.
 *
 * Returns null only when the string genuinely doesn't point to a specific day
 * ("sometime in summer", "may" with no day, garbage). The onboarding handler
 * falls back to an LLM parse on null before re-asking the user.
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

  // Relative phrases (whole-string).
  const lower = s.toLowerCase();
  if (lower === 'today' || lower === 'tonight') return toISO(today);
  if (lower === 'tomorrow') return toISO(addDays(today, 1));
  const weekday = parseRelativeWeekday(lower, today);
  if (weekday) return weekday;
  const offset = parseRelativeOffset(lower, today);
  if (offset) return offset;

  // A full date that already carries an explicit year ("May 28 2026",
  // "05/28/2026"). Only trust Date.parse when a 4-digit year is present — it's
  // too eager to invent missing parts otherwise.
  if (/\d{4}/.test(s)) {
    const withExplicitYear = parseViaDateParse(s);
    if (withExplicitYear) return withExplicitYear;
  }

  // Purely numeric date with separators ("27-6-26", "27/6/26").
  const numeric = parseNumericDMY(s, today);
  if (numeric) return numeric;

  // Month + day with no year ("November 1", "1 Nov") → next future occurrence.
  const monthDay = parseMonthDayNoYear(s, today);
  if (monthDay) return monthDay;

  // Embedded date inside a longer string ("tomorrow 27-6-26", "leaving 27/6").
  // Recurse only on a PROPER substring (strictly shorter) so a whole-string but
  // invalid date (e.g. "31-2-26") can't match itself and loop forever — that
  // case already returned null from the parsers above and must stay null.
  for (const re of EMBEDDED_DATE_PATTERNS) {
    const match = s.match(re);
    if (match && match[0] !== s) {
      const iso = tryParseToISO(match[0], now);
      if (iso) return iso;
    }
  }

  // Last resort: a leading relative keyword trailed by other words
  // ("tomorrow morning", "today if it's sunny").
  if (/^(today|tonight)\b/.test(lower)) return toISO(today);
  if (/^tomorrow\b/.test(lower)) return toISO(addDays(today, 1));

  return null;
}

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
 * Today's calendar date as ISO "YYYY-MM-DD" in a specific IANA timezone
 * (e.g. "Europe/Oslo"). This is the user-facing "today": the server runs in UTC
 * on Vercel, so any trip-logic notion of the current day MUST resolve through
 * the driver's own zone or it drifts a day near midnight (the day-you're-on-
 * shows-as-completed bug). Falls back to the runtime-local date when `timeZone`
 * is null/empty (not yet captured) or invalid (Intl throws on a bad zone).
 */
export function todayISOInZone(
  timeZone: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!timeZone) return toISO(now);
  try {
    // en-CA renders as "YYYY-MM-DD"; `format` applies the zone offset for us.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return toISO(now);
  }
}

/**
 * Decide how many leading legs are "behind" the driver — the cutoff index used
 * to tuck completed/past days into the collapsible "behind you" section so the
 * itinerary opens at today rather than at a day that has already passed.
 *
 * Returns the rank of the first still-ahead leg: 0 means nothing is behind,
 * `legDateISOs.length` means the whole trip is behind.
 *
 * Two signals, combined as a MAX (the later of the two wins):
 *   1. Calendar: every leg dated strictly before `todayISO` is behind you;
 *      "ahead" begins at the first leg dated today-or-later. Leg dates are a
 *      hard invariant (see Leg.date_iso) and are re-anchored from the driver's
 *      reported progress (getTripFull), so this already reflects any report.
 *      ISO "YYYY-MM-DD" strings compare lexicographically.
 *   2. Explicit report (`reportedRank >= 0`): a deliberate "I'm here" sets a
 *      FLOOR — we never collapse a leg the driver said they'd reached. It does
 *      NOT freeze the view: a FRESH report agrees with the calendar (its leg is
 *      re-anchored to the report date = today), while a STALE report (made days
 *      ago) lets the calendar advance past it as real days pass. This is the fix
 *      for "reported on day N, still pinned to day N when viewed on day N+8".
 *
 * Taking the max lets the cutoff move FORWARD of the last report as time passes,
 * but never pulls it BACK behind a leg the driver explicitly reached (guards
 * against GPS/clock noise collapsing a day they said they're on).
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
  const n = legDateISOs.length;

  // Calendar cutoff: collapse every leg dated strictly before today.
  let calendarCutoff = 0;
  while (calendarCutoff < n && legDateISOs[calendarCutoff] < todayISO) {
    calendarCutoff++;
  }

  // An explicit report is a floor, not a freeze: it keeps the view from
  // collapsing a leg ahead of where the driver said they are, but the calendar
  // can still advance past a stale report.
  const reportedCutoff = reportedRank >= 0 ? Math.min(reportedRank, n) : 0;

  const cutoff = Math.max(reportedCutoff, calendarCutoff);

  // If every leg is in the past (trip fully elapsed), keep the last leg visible
  // so the main list is never empty.
  if (cutoff === n && n > 0) {
    return n - 1;
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
