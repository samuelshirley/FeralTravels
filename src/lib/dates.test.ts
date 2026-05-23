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
} from './dates';

describe('legDateISO', () => {
  it('assigns one calendar day per leg index', () => {
    expect(legDateISO('2026-05-29', 0)).toBe('2026-05-29');
    expect(legDateISO('2026-05-29', 1)).toBe('2026-05-30');
    expect(legDateISO('2026-05-29', 5)).toBe('2026-06-03'); // crosses month
  });

  it('returns null without a start date', () => {
    expect(legDateISO(null, 3)).toBeNull();
    expect(legDateISO(undefined, 3)).toBeNull();
    expect(legDateISO('', 3)).toBeNull();
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
