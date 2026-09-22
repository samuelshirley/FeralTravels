import { describe, it, expect } from 'vitest';
import {
  isStartDateAnswered,
  formatTripDateRange,
  groupByStartDate,
  mostRecentlyActive,
} from './tripsListDates';

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

describe('groupByStartDate', () => {
  const t = (id: string, start: string, set = true) => ({ id, start_date_parsed: start, start_date_set: set });

  it('puts consecutive trips sharing a start date under ONE header', () => {
    const groups = groupByStartDate([t('a', '2026-10-08'), t('b', '2026-10-08'), t('c', '2026-09-16')]);
    expect(groups.map((g) => [g.label, g.trips.map((x) => x.id)])).toEqual([
      ['08 Oct 2026', ['a', 'b']],
      ['16 Sep 2026', ['c']],
    ]);
  });

  it('gives the placeholder date no header, and never merges it into a real one', () => {
    const groups = groupByStartDate([t('new', '2026-09-22', false), t('real', '2026-09-22')]);
    expect(groups.map((g) => g.label)).toEqual([null, '22 Sep 2026']);
  });

  it('keys are unique even when a date recurs non-consecutively', () => {
    const groups = groupByStartDate([t('a', '2026-10-08'), t('b', '2026-09-16'), t('c', '2026-10-08')]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });
});

describe('mostRecentlyActive', () => {
  it('picks by last_activity_at, not list position', () => {
    const list = [
      { id: 'future', last_activity_at: '2026-09-01T10:00:00.000Z' },
      { id: 'lastUsed', last_activity_at: '2026-09-22T08:00:00.000Z' },
    ];
    expect(mostRecentlyActive(list)?.id).toBe('lastUsed');
  });

  it('is undefined for no trips, and falls back to the head without timestamps', () => {
    expect(mostRecentlyActive([])).toBeUndefined();
    const bare: { id: string; last_activity_at?: string }[] = [{ id: 'x' }, { id: 'y' }];
    expect(mostRecentlyActive(bare)?.id).toBe('x');
  });
});
