/**
 * Which day of the trip does a message name? A deterministic, free parse —
 * case 2 of the Jev route measurement ("add this to day 3").
 *
 * The question this exists to answer is whether a code path that adds a
 * pasted place needs a model to find the day at all. So it is deliberately a
 * small set of unambiguous forms, and it says "ambiguous" or "none" rather
 * than guessing; the compare rows then record its answer beside the day Penny
 * actually put the stop on (`repos/jev.ts`), and /admin shows how often the
 * two agree. If they agree, the day needs no Jev Score and no Haiku.
 *
 * Day N is the N-th leg in `sort_order` — the same numbering the itinerary and
 * the map's day markers use (`mapDayMarkers.ts`): every leg, driving or rest,
 * is one calendar day, the first on the trip's start date.
 *
 * Forms understood (case-insensitive):
 *   - "day 3", "day three"                                  → day_number
 *   - "the third day", "3rd day", "first day"               → ordinal
 *   - "the last day", "final day"                           → last
 *   - "today", "tonight", "tomorrow", "day after tomorrow"  → relative (needs the start date)
 *   - "2026-11-14", "Nov 14", "14 November", "the 14th"     → date     (needs the start date)
 *   - "on Saturday"                                         → weekday  (needs the start date)
 * Two different days named → "ambiguous". Numeric dates like 14/11 are NOT
 * read: day-month and month-day disagree, and guessing is the thing this
 * module must not do.
 *
 * Pure: no clock (today is an argument), no timezone (ISO calendar dates
 * only, computed in UTC so the host's zone cannot shift a day).
 */

export type DayReferenceKind = 'day_number' | 'ordinal' | 'last' | 'relative' | 'date' | 'weekday';

export type DayReference =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  /** A date-relative form, but the trip has no start date to count from. */
  | { kind: 'no_start' }
  | { kind: DayReferenceKind; day: number; inRange: boolean };

export interface DayFrame {
  /** How many days (legs) the trip has. */
  dayCount: number;
  /** "YYYY-MM-DD" of day 1, or null when the trip has no start date. */
  tripStartISO: string | null;
  /** "YYYY-MM-DD" today, in the driver's own timezone. */
  todayISO: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function isoToUtcMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Reject 2026-02-31 and friends, which Date.UTC silently rolls over.
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/** Day number (1-based) of `iso` on a trip starting `startISO`, or null. */
function dayOf(startISO: string, iso: string): number | null {
  const a = isoToUtcMs(startISO);
  const b = isoToUtcMs(iso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

function isoPlus(iso: string, days: number): string | null {
  const ms = isoToUtcMs(iso);
  if (ms === null) return null;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A month/day with no year: the first occurrence on or after the trip's
 * start, looking at most a year ahead — "Nov 14" on a December trip is next
 * November, which is then simply out of range.
 */
function monthDayToDay(startISO: string, month: number, dom: number): number | null {
  const startYear = Number(startISO.slice(0, 4));
  for (const year of [startYear, startYear + 1]) {
    const iso = `${year}-${pad(month)}-${pad(dom)}`;
    const day = dayOf(startISO, iso);
    if (day !== null && day >= 1) return day;
  }
  return null;
}

type Hit = { kind: DayReferenceKind; day: number } | { kind: 'no_start' };

function collect(message: string, frame: DayFrame): Hit[] {
  const text = message.toLowerCase();
  const hits: Hit[] = [];
  const start = frame.tripStartISO && isoToUtcMs(frame.tripStartISO) !== null ? frame.tripStartISO : null;
  const needStart = (fn: (s: string) => number | null, kind: DayReferenceKind) => {
    if (!start) {
      hits.push({ kind: 'no_start' });
      return;
    }
    const day = fn(start);
    if (day !== null) hits.push({ kind, day });
  };

  for (const m of text.matchAll(/\bday\s*#?\s*(\d{1,3})\b/g)) hits.push({ kind: 'day_number', day: Number(m[1]) });
  for (const m of text.matchAll(new RegExp(`\\bday\\s+(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g'))) {
    hits.push({ kind: 'day_number', day: NUMBER_WORDS[m[1]] });
  }
  for (const m of text.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)\s+day\b/g)) hits.push({ kind: 'ordinal', day: Number(m[1]) });
  for (const m of text.matchAll(new RegExp(`\\b(${Object.keys(ORDINAL_WORDS).join('|')})\\s+day\\b`, 'g'))) {
    hits.push({ kind: 'ordinal', day: ORDINAL_WORDS[m[1]] });
  }
  if (/\b(?:last|final)\s+day\b/.test(text)) hits.push({ kind: 'last', day: frame.dayCount });

  const today = frame.todayISO;
  if (/\bday\s+after\s+tomorrow\b/.test(text)) {
    needStart((s) => dayOf(s, isoPlus(today, 2) ?? ''), 'relative');
  } else if (/\btomorrow\b/.test(text)) {
    needStart((s) => dayOf(s, isoPlus(today, 1) ?? ''), 'relative');
  }
  if (/\b(?:today|tonight)\b/.test(text)) needStart((s) => dayOf(s, today), 'relative');

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    needStart((s) => dayOf(s, `${m[1]}-${m[2]}-${m[3]}`), 'date');
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) {
    needStart((s) => monthDayToDay(s, MONTHS[m[1]], Number(m[2])), 'date');
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`, 'g'))) {
    needStart((s) => monthDayToDay(s, MONTHS[m[2]], Number(m[1])), 'date');
  }
  // "the 14th" with no month: the first trip day falling on that day of a month.
  if (!new RegExp(`\\b(?:${MONTH_RE})\\b`).test(text)) {
    for (const m of text.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+day)/g)) {
      const dom = Number(m[1]);
      needStart((s) => {
        for (let i = 0; i < Math.max(frame.dayCount, 1) + 31; i++) {
          const iso = isoPlus(s, i);
          if (iso && Number(iso.slice(8, 10)) === dom) return i + 1;
        }
        return null;
      }, 'date');
    }
  }
  for (const m of text.matchAll(/\b(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const wd = WEEKDAYS[m[1]];
    needStart((s) => {
      // The first trip day on that weekday that is today or later.
      const from = Math.max(1, dayOf(s, today) ?? 1);
      for (let day = from; day < from + 7; day++) {
        const iso = isoPlus(s, day - 1);
        if (iso && new Date(isoToUtcMs(iso)!).getUTCDay() === wd) return day;
      }
      return null;
    }, 'weekday');
  }
  return hits;
}

export function parseDayReference(message: string, frame: DayFrame): DayReference {
  const hits = collect(message, frame);
  if (hits.length === 0) return { kind: 'none' };
  const days = new Set<number>();
  let first: { kind: DayReferenceKind; day: number } | null = null;
  let noStart = false;
  for (const h of hits) {
    if (h.kind === 'no_start') {
      noStart = true;
      continue;
    }
    days.add(h.day);
    first ??= h;
  }
  if (days.size > 1) return { kind: 'ambiguous' };
  if (!first) return noStart ? { kind: 'no_start' } : { kind: 'none' };
  // A day-number form AND a date form that could not be resolved is still two
  // claims; only one we could read is not enough to call it settled.
  if (noStart) return { kind: 'ambiguous' };
  return { kind: first.kind, day: first.day, inRange: first.day >= 1 && first.day <= frame.dayCount };
}
