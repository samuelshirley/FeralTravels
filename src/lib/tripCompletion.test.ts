import { describe, expect, it } from 'vitest';
import { todayISOInZone } from '@/lib/dates';
import {
  isTripCompleted,
  lastDayFromLegDates,
  lastDayFromSchedule,
} from '@/lib/tripCompletion';

describe('lastDayFromLegDates', () => {
  it('returns the latest leg date', () => {
    expect(lastDayFromLegDates(['2026-06-01', '2026-06-02', '2026-06-03'])).toBe(
      '2026-06-03',
    );
  });

  it('is order-independent', () => {
    expect(lastDayFromLegDates(['2026-06-03', '2026-06-01'])).toBe('2026-06-03');
  });

  it('returns null for a trip with no legs', () => {
    expect(lastDayFromLegDates([])).toBe(null);
    expect(lastDayFromLegDates(null)).toBe(null);
    expect(lastDayFromLegDates(undefined)).toBe(null);
  });

  it('ignores entries that are not ISO dates', () => {
    expect(lastDayFromLegDates([null, '', 'next Tuesday', '2026-06-01'])).toBe(
      '2026-06-01',
    );
    expect(lastDayFromLegDates(['late June'])).toBe(null);
  });
});

describe('lastDayFromSchedule', () => {
  it('counts one calendar day per leg from the trip start', () => {
    expect(
      lastDayFromSchedule({ startDateISO: '2026-06-01', legCount: 3 }),
    ).toBe('2026-06-03');
  });

  it('is the start date itself for a one-day trip', () => {
    expect(
      lastDayFromSchedule({ startDateISO: '2026-06-01', legCount: 1 }),
    ).toBe('2026-06-01');
  });

  it('re-anchors the calendar from a progress report', () => {
    // Day 2 of a 5-day trip was reported as falling on the 10th, so the trip
    // effectively starts on the 9th and its last day slides to the 13th.
    expect(
      lastDayFromSchedule({
        startDateISO: '2026-06-01',
        legCount: 5,
        currentLegRank: 1,
        progressAnchorISO: '2026-06-10',
      }),
    ).toBe('2026-06-13');
  });

  it('ignores a leg pointer with no anchor date (stale/legacy row)', () => {
    expect(
      lastDayFromSchedule({
        startDateISO: '2026-06-01',
        legCount: 3,
        currentLegRank: 2,
        progressAnchorISO: null,
      }),
    ).toBe('2026-06-03');
  });

  it('returns null when the trip has no legs or no usable start date', () => {
    expect(lastDayFromSchedule({ startDateISO: '2026-06-01', legCount: 0 })).toBe(null);
    expect(lastDayFromSchedule({ startDateISO: null, legCount: 3 })).toBe(null);
    expect(lastDayFromSchedule({ startDateISO: 'summer', legCount: 3 })).toBe(null);
  });
});

describe('isTripCompleted', () => {
  const today = '2026-06-15';

  it('is completed when the last day was yesterday', () => {
    expect(isTripCompleted('2026-06-14', today)).toBe(true);
  });

  it('is NOT completed when the last day is today — the day you are on is not behind you', () => {
    expect(isTripCompleted(today, today)).toBe(false);
  });

  it('is NOT completed when the last day is tomorrow', () => {
    expect(isTripCompleted('2026-06-16', today)).toBe(false);
  });

  it('is NOT completed for a trip with no dates at all', () => {
    // Never guess: an undated trip is one the user is still planning.
    expect(isTripCompleted(lastDayFromLegDates([]), today)).toBe(false);
    expect(isTripCompleted(null, today)).toBe(false);
    expect(isTripCompleted(undefined, today)).toBe(false);
  });

  it('is NOT completed when the dates are unparseable', () => {
    expect(isTripCompleted('late May', today)).toBe(false);
    expect(isTripCompleted('2026-06-14', 'today')).toBe(false);
  });

  it('crosses a year boundary correctly', () => {
    expect(isTripCompleted('2025-12-31', '2026-01-01')).toBe(true);
    expect(isTripCompleted('2026-01-01', '2025-12-31')).toBe(false);
  });

  it("uses the driver's zone, not the server's: a last day that is still today in their zone is not completed", () => {
    // 02:00 UTC on the 27th is still the 26th in Los Angeles. A trip ending on
    // the 26th is the day the driver is ON — the regression this repo has
    // actually shipped (a UTC "today" collapsing the current day into the past).
    const now = new Date('2026-08-27T02:00:00Z');
    const driverToday = todayISOInZone('America/Los_Angeles', now);
    expect(driverToday).toBe('2026-08-26');
    expect(isTripCompleted('2026-08-26', driverToday)).toBe(false);

    // The same instant read on the server's own UTC clock is already the
    // 27th, which retires the trip a day early. That is what the bug looked
    // like, and why every caller resolves today through the driver's zone.
    expect(todayISOInZone('UTC', now)).toBe('2026-08-27');
    expect(isTripCompleted('2026-08-26', todayISOInZone('UTC', now))).toBe(true);
  });
});
