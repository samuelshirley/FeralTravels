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

  it('lets an explicit position report win over the calendar', () => {
    const legDateISOs = ['2026-05-30', '2026-05-31', '2026-06-03'];
    expect(behindCutoffRank({ reportedRank: 2, legDateISOs, todayISO: today })).toBe(2);
  });

  it('clamps an out-of-range reported rank', () => {
    const legDateISOs = ['2026-05-30', '2026-05-31'];
    expect(behindCutoffRank({ reportedRank: 99, legDateISOs, todayISO: today })).toBe(2);
  });
});
