import { describe, it, expect } from 'vitest';
import { isStartDateAnswered, formatTripDateRange } from './tripsListDates';

describe('isStartDateAnswered', () => {
  it('is false while the start date is still the today placeholder', () => {
    // What a first-run trip left at the opening question actually holds.
    expect(isStartDateAnswered('not_started', null)).toBe(false);
    expect(isStartDateAnswered('trip_intent', null)).toBe(false);
    expect(isStartDateAnswered('trip_date', { origin_place: 'Lyon' })).toBe(false);
  });

  it('at trip_origin, is true only when the opening message pinned the date', () => {
    expect(isStartDateAnswered('trip_origin', null)).toBe(false);
    expect(isStartDateAnswered('trip_origin', { date_skipped: true })).toBe(true);
  });

  it('is true once onboarding has moved past the date', () => {
    for (const s of ['trip_pace', 'units_pick', 'vehicle_new', 'range_help', 'done'] as const) {
      expect(isStartDateAnswered(s, null)).toBe(true);
    }
  });
});

describe('formatTripDateRange', () => {
  it('formats the machine columns as DD Mon YYYY', () => {
    expect(
      formatTripDateRange({ start_date_parsed: '2026-10-08', end_date_parsed: '2026-10-21', start_date_set: true }),
    ).toBe('08 Oct 2026 → 21 Oct 2026');
  });

  it('shows one date for a one-day or open-ended trip', () => {
    expect(formatTripDateRange({ start_date_parsed: '2026-10-08', end_date_parsed: '2026-10-08' })).toBe('08 Oct 2026');
    expect(formatTripDateRange({ start_date_parsed: '2026-10-08', end_date_parsed: null })).toBe('08 Oct 2026');
  });

  it('shows nothing for the placeholder, or a value that is not a date', () => {
    expect(
      formatTripDateRange({ start_date_parsed: '2026-09-22', end_date_parsed: null, start_date_set: false }),
    ).toBe('');
    expect(formatTripDateRange({ start_date_parsed: 'On October 12', end_date_parsed: null })).toBe('');
  });
});
