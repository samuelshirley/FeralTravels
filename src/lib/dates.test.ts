/**
 * Tests for the date-model domain helpers in dates.ts — calendar-date
 * assignment and fixed-date constraint scheduling. Pure functions, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  legDateISO,
  daysBetweenISO,
  constraintLocalDateISO,
  requiredRestDaysBefore,
  behindCutoffRank,
  tryParseToISO,
  extractDateFromText,
  todayISOInZone,
} from './dates';

describe('extractDateFromText', () => {
  const now = new Date(2026, 4, 31); // Sun May 31 2026

  it('pulls a date out of a trip description', () => {
    expect(
      extractDateFromText(
        'i want to visit every national park, started November 1st, from austin texas',
        now,
      ),
    ).toBe('2026-11-01');
  });

  it('handles ISO, day-month, and explicit-year forms in prose', () => {
    expect(extractDateFromText('leaving on 2026-06-03 heading north', now)).toBe('2026-06-03');
    expect(extractDateFromText('we set off 3 June 2026 from home', now)).toBe('2026-06-03');
    expect(extractDateFromText('depart June 3 2026, arrive whenever', now)).toBe('2026-06-03');
  });

  it('does not mistake stray numbers for dates', () => {
    expect(
      extractDateFromText('clockwise loop of the US, spend 2 days there every time', now),
    ).toBeNull();
    expect(extractDateFromText('just a road trip, no dates yet', now)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(extractDateFromText('', now)).toBeNull();
    expect(extractDateFromText(null, now)).toBeNull();
  });
});

describe('tryParseToISO', () => {
  // Sunday, May 31 2026 — fixed anchor for year-inference + relative phrases.
  const now = new Date(2026, 4, 31);

  it('passes ISO straight through', () => {
    expect(tryParseToISO('2026-06-03', now)).toBe('2026-06-03');
  });

  it('parses dates that carry a year', () => {
    expect(tryParseToISO('June 3 2026', now)).toBe('2026-06-03');
    expect(tryParseToISO('June 3, 2026', now)).toBe('2026-06-03');
    expect(tryParseToISO('3 June 2026', now)).toBe('2026-06-03');
    expect(tryParseToISO('06/03/2026', now)).toBe('2026-06-03');
  });

  it('strips ordinal suffixes', () => {
    expect(tryParseToISO('June 3rd 2026', now)).toBe('2026-06-03');
    expect(tryParseToISO('November 1st', now)).toBe('2026-11-01');
  });

  it('infers the year for a month/day with none (this year if still ahead)', () => {
    expect(tryParseToISO('November 1', now)).toBe('2026-11-01');
    expect(tryParseToISO('Nov 1', now)).toBe('2026-11-01');
    expect(tryParseToISO('1 November', now)).toBe('2026-11-01');
  });

  it('rolls a past month/day forward to next year', () => {
    // Jan 5 already passed in 2026 (now = May 31) → next is 2027.
    expect(tryParseToISO('January 5', now)).toBe('2027-01-05');
  });

  it('handles relative phrases', () => {
    expect(tryParseToISO('today', now)).toBe('2026-05-31');
    expect(tryParseToISO('tomorrow', now)).toBe('2026-06-01');
    // now is a Sunday → next Saturday is Jun 6; "saturday" alone is the same.
    expect(tryParseToISO('next Saturday', now)).toBe('2026-06-06');
    expect(tryParseToISO('saturday', now)).toBe('2026-06-06');
  });

  it('returns null for non-specific or garbage input', () => {
    expect(tryParseToISO('sometime in summer', now)).toBeNull();
    expect(tryParseToISO('may', now)).toBeNull();
    expect(tryParseToISO('', now)).toBeNull();
    expect(tryParseToISO(null, now)).toBeNull();
    expect(tryParseToISO('asdf', now)).toBeNull();
  });

  it('parses numeric dates with separators (day-first for dash/dot)', () => {
    expect(tryParseToISO('27-6-26', now)).toBe('2026-06-27');
    expect(tryParseToISO('27/6/2026', now)).toBe('2026-06-27');
    expect(tryParseToISO('27.06.2026', now)).toBe('2026-06-27');
    // Slash defaults US month-first when ambiguous (preserves Date.parse behavior).
    expect(tryParseToISO('06/03/26', now)).toBe('2026-06-03');
    // Slash where the first value can't be a month → falls back to day-first.
    expect(tryParseToISO('27/6/26', now)).toBe('2026-06-27');
    // Dash where the second value can't be a month → month-first.
    expect(tryParseToISO('6-27-26', now)).toBe('2026-06-27');
  });

  it('rejects impossible numeric dates', () => {
    expect(tryParseToISO('31-2-26', now)).toBeNull(); // Feb 31
    expect(tryParseToISO('45-13-26', now)).toBeNull();
  });

  it('handles relative offset phrases', () => {
    expect(tryParseToISO('next week', now)).toBe('2026-06-07');
    expect(tryParseToISO('in 3 days', now)).toBe('2026-06-03');
    expect(tryParseToISO('in 2 weeks', now)).toBe('2026-06-14');
    expect(tryParseToISO('in a month', now)).toBe('2026-06-30');
    expect(tryParseToISO('tonight', now)).toBe('2026-05-31');
  });

  it('pulls an embedded date out of a relative-word combo (the reported bug)', () => {
    // "Tomorrow 27-6-26" used to 500 — the embedded numeric date now resolves.
    expect(tryParseToISO('Tomorrow 27-6-26', new Date(2026, 5, 26))).toBe('2026-06-27');
    expect(tryParseToISO('leaving 27/6/26', now)).toBe('2026-06-27');
  });

  it('falls back to a leading relative word when no explicit date is present', () => {
    expect(tryParseToISO('tomorrow morning', now)).toBe('2026-06-01');
    expect(tryParseToISO('today if the weather holds', now)).toBe('2026-05-31');
  });
});

describe('legDateISO', () => {
  it('assigns one calendar day per leg index', () => {
    expect(legDateISO('2026-05-29', 0)).toBe('2026-05-29');
    expect(legDateISO('2026-05-29', 1)).toBe('2026-05-30');
    expect(legDateISO('2026-05-29', 5)).toBe('2026-06-03'); // crosses month
  });

});

describe('daysBetweenISO', () => {
  it('counts whole calendar days', () => {
    expect(daysBetweenISO('2026-05-29', '2026-06-03')).toBe(5);
    expect(daysBetweenISO('2026-06-03', '2026-05-29')).toBe(-5);
    expect(daysBetweenISO('2026-05-29', '2026-05-29')).toBe(0);
  });

  it('returns null on unparseable input', () => {
    expect(daysBetweenISO(null, '2026-06-03')).toBeNull();
    expect(daysBetweenISO('2026-06-03', null)).toBeNull();
  });
});

describe('constraintLocalDateISO', () => {
  it('takes the local date prefix without timezone shifting', () => {
    // 08:00 +02:00 is still 2026-06-03 locally — must not roll back to the 2nd.
    expect(constraintLocalDateISO('2026-06-03T08:00:00+02:00')).toBe('2026-06-03');
    expect(constraintLocalDateISO('2026-06-03T23:30:00-07:00')).toBe('2026-06-03');
    expect(constraintLocalDateISO('2026-06-03')).toBe('2026-06-03');
  });

  it('falls back to loose parsing', () => {
    expect(constraintLocalDateISO('June 3, 2026')).toBe('2026-06-03');
  });

  it('returns null on garbage', () => {
    expect(constraintLocalDateISO(null)).toBeNull();
    expect(constraintLocalDateISO('not a date')).toBeNull();
  });
});

describe('requiredRestDaysBefore', () => {
  it('Bad Kissingen case: 3 rest days needed before the June 3 drive', () => {
    // Depart Girona May 29. Two driving days before the anchored leg
    // (Girona→Lyon, Lyon→Innsbruck). Must depart Innsbruck on June 3.
    const rest = requiredRestDaysBefore({
      tripStartISO: '2026-05-29',
      targetDateISO: '2026-06-03',
      driveDaysBefore: 2,
    });
    expect(rest).toBe(3); // May 31, Jun 1, Jun 2
  });

  it('negative when the fixed date is physically too early', () => {
    const rest = requiredRestDaysBefore({
      tripStartISO: '2026-05-29',
      targetDateISO: '2026-05-30',
      driveDaysBefore: 3, // 3 driving days can't fit before May 30
    });
    expect(rest).toBeLessThan(0);
  });

  it('returns null when dates are missing', () => {
    expect(
      requiredRestDaysBefore({ tripStartISO: null, targetDateISO: '2026-06-03', driveDaysBefore: 2 }),
    ).toBeNull();
  });
});

describe('todayISOInZone', () => {
  // 2026-06-30T23:30:00Z — late evening UTC. In a positive-offset zone it's
  // already the NEXT calendar day; in a negative-offset zone it's still the 30th.
  const lateUtc = new Date('2026-06-30T23:30:00Z');

  it('rolls forward to the local day in a positive-offset zone', () => {
    // Oslo (UTC+2 in summer) → 01:30 on 2026-07-01.
    expect(todayISOInZone('Europe/Oslo', lateUtc)).toBe('2026-07-01');
  });

  it('stays on the UTC day in a negative-offset zone', () => {
    // New York (UTC-4 in summer) → 19:30 on 2026-06-30.
    expect(todayISOInZone('America/New_York', lateUtc)).toBe('2026-06-30');
  });

  it('reproduces the bug class: same instant, different calendar day by zone', () => {
    // Early-morning UTC where Oslo and New York disagree on the date.
    const earlyUtc = new Date('2026-06-30T01:00:00Z');
    expect(todayISOInZone('Europe/Oslo', earlyUtc)).toBe('2026-06-30'); // 03:00
    expect(todayISOInZone('America/New_York', earlyUtc)).toBe('2026-06-29'); // 21:00 prev day
  });

  it('falls back to the runtime-local date when zone is null/empty', () => {
    const now = new Date(2026, 5, 30, 12, 0, 0); // local noon Jun 30
    expect(todayISOInZone(null, now)).toBe('2026-06-30');
    expect(todayISOInZone('', now)).toBe('2026-06-30');
  });

  it('falls back to the runtime-local date when zone is invalid', () => {
    const now = new Date(2026, 5, 30, 12, 0, 0);
    expect(todayISOInZone('Not/AZone', now)).toBe('2026-06-30');
  });
});

describe('behindCutoffRank', () => {
  const today = '2026-05-31';

  it('collapses calendar days strictly before today, keeps today visible', () => {
    // Leg 0 = yesterday (drive), leg 1 = today (rest), leg 2+ = future.
    const legDateISOs = ['2026-05-30', '2026-05-31', '2026-06-03', '2026-06-04'];
    expect(behindCutoffRank({ reportedRank: -1, legDateISOs, todayISO: today })).toBe(1);
  });

  it('collapses nothing when the first leg is today', () => {
    const legDateISOs = ['2026-05-31', '2026-06-01'];
    expect(behindCutoffRank({ reportedRank: -1, legDateISOs, todayISO: today })).toBe(0);
  });

  it('collapses nothing when the whole trip is in the future', () => {
    const legDateISOs = ['2026-06-01', '2026-06-02'];
    expect(behindCutoffRank({ reportedRank: -1, legDateISOs, todayISO: today })).toBe(0);
  });

  it('keeps the last leg visible when the whole trip is in the past', () => {
    const legDateISOs = ['2026-05-20', '2026-05-21', '2026-05-22'];
    expect(behindCutoffRank({ reportedRank: -1, legDateISOs, todayISO: today })).toBe(2);
  });

  it('lets an explicit report hold a leg ahead of the calendar (floor)', () => {
    // Driver reported being at a future-dated leg (jumped ahead). The report
    // floor keeps that leg at the top even though the calendar alone would
    // collapse fewer days.
    const legDateISOs = ['2026-05-30', '2026-05-31', '2026-06-03'];
    expect(behindCutoffRank({ reportedRank: 2, legDateISOs, todayISO: today })).toBe(2);
  });

  it('clamps an out-of-range reported rank and keeps the last leg visible', () => {
    const legDateISOs = ['2026-05-30', '2026-05-31'];
    // Clamped to length, then the never-empty guard keeps the last leg visible.
    expect(behindCutoffRank({ reportedRank: 99, legDateISOs, todayISO: today })).toBe(1);
  });

  it('advances past a STALE report as real days pass (the frozen-itinerary bug)', () => {
    // Reproduces the photographed bug: the driver reported position on an early
    // leg (day 8 = 2026-06-10) and never reported again. Eight days later the
    // old "report always wins" code kept the itinerary pinned to 2026-06-10; the
    // fix lets the calendar advance past the stale report.
    const legDateISOs = Array.from({ length: 20 }, (_, i) => {
      const d = new Date(2026, 5, 3 + i); // 2026-06-03 .. 2026-06-22
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    });
    const reportedRank = 7; // 2026-06-10

    // Stale: viewed on 2026-06-18, eight days after the report → calendar wins.
    expect(
      behindCutoffRank({ reportedRank, legDateISOs, todayISO: '2026-06-18' }),
    ).toBe(15); // first leg dated >= 2026-06-18

    // Fresh: viewed on the report date → report and calendar agree.
    expect(
      behindCutoffRank({ reportedRank, legDateISOs, todayISO: '2026-06-10' }),
    ).toBe(7);

    // Fresh report and the (re-anchored) calendar coincide — no double-collapse.
    expect(
      behindCutoffRank({ reportedRank: 3, legDateISOs, todayISO: '2026-06-06' }),
    ).toBe(3);
  });
});
