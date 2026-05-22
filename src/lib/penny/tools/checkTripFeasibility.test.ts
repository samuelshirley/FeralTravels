/**
 * Tests for checkTripFeasibility — both the existing day-count math
 * and the new day-model-aware allocation.
 *
 * NOTE: This file tests the pure `computeFeasibility` function, not
 * the Anthropic tool wrapper. No DB, no network, no 'server-only'.
 */
import { describe, it, expect } from 'vitest';

// We need to mock the 'server-only' import since this is a test file
// running outside Next.js server context.
import { vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { computeFeasibility, type CheckTripFeasibilityInput } from './checkTripFeasibility';

/** Shorthand: fill in Zod defaults that computeFeasibility expects. */
function feasInput(
  overrides: Partial<CheckTripFeasibilityInput> &
    Pick<CheckTripFeasibilityInput, 'segment_drive_days' | 'waypoint_nights' | 'time_budget_days'>
): CheckTripFeasibilityInput {
  return {
    destination_nights: null,
    buffer_days: 0,
    constraint_checks: [],
    ...overrides,
  } as CheckTripFeasibilityInput;
}

// ---------------------------------------------------------------------------
// Existing behavior — backward compat (no new fields)
// ---------------------------------------------------------------------------

describe('computeFeasibility (existing behavior)', () => {
  it('basic fits case', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [2, 1],
      waypoint_nights: [2],
      time_budget_days: 7,
    }));
    expect(result.verdict).toBe('fits');
    expect(result.feasible).toBe(true);
    expect(result.total_driving_days).toBe(3);
    expect(result.total_transit_nights).toBe(2);
    expect(result.total_min_days_needed).toBe(5);
    expect(result.recommended_allocation).toBeNull();
  });

  it('over budget', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [3, 2],
      waypoint_nights: [3],
      time_budget_days: 6,
    }));
    expect(result.verdict).toBe('over_budget');
    expect(result.feasible).toBe(false);
    expect(result.shortfall_days).toBe(2);
    expect(result.recommended_allocation).toBeNull();
  });

  it('tight fit', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [2, 1],
      waypoint_nights: [2],
      time_budget_days: 5,
    }));
    expect(result.verdict).toBe('tight');
    expect(result.feasible).toBe(true);
  });

  it('no budget', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [2],
      waypoint_nights: [],
      time_budget_days: null,
    }));
    expect(result.verdict).toBe('no_budget');
    expect(result.feasible).toBe(true);
    expect(result.recommended_allocation).toBeNull();
  });

  it('destination nights excluded from transit budget', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [2],
      waypoint_nights: [],
      destination_nights: 5,
      time_budget_days: 3,
    }));
    // 2 drive days ≤ 3 budget → fits (destination nights don't count)
    expect(result.verdict).toBe('fits');
    expect(result.total_trip_days).toBe(7); // 2 drive + 5 destination
  });
});

// ---------------------------------------------------------------------------
// Day model allocation — the Bad Kissingen fix
// ---------------------------------------------------------------------------

describe('computeFeasibility (day model allocation)', () => {
  it('Bad Kissingen: returns recommended 4 nights at Innsbruck', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1],
      waypoint_nights: [3], // Penny guessed 3
      time_budget_days: null,
      flexible_waypoints: [
        { name: 'Innsbruck', min_nights: 2, preferred_nights: 4 },
      ],
      arrival_deadline: {
        datetime: '2026-06-03T15:00:00+02:00',
        local_time: '15:00',
        buffer_minutes: 60,
      },
      departure_date: '2026-05-28',
      segment_drive_minutes: [759, 312],
      final_segment_drive_minutes: 312,
    }));

    expect(result.recommended_allocation).not.toBeNull();
    expect(result.recommended_allocation!.recommended_nights).toEqual([4]);
    expect(result.recommended_allocation!.same_day_arrival).toBe(true);
    expect(result.recommended_allocation!.total_days).toBe(6);
    expect(result.recommended_allocation!.slack_minutes).toBeGreaterThan(0);
    expect(result.summary).toContain('RECOMMENDED ALLOCATION');
  });

  it('returns null when day model fields are omitted (backward compat)', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1],
      waypoint_nights: [3],
      time_budget_days: null,
    }));

    expect(result.recommended_allocation).toBeNull();
  });

  it('works with budget + day model together', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1],
      waypoint_nights: [3],
      time_budget_days: 6,
      flexible_waypoints: [
        { name: 'Innsbruck', min_nights: 2, preferred_nights: 4 },
      ],
      arrival_deadline: {
        datetime: '2026-06-03T15:00:00+02:00',
        local_time: '15:00',
        buffer_minutes: 60,
      },
      departure_date: '2026-05-28',
      segment_drive_minutes: [759, 312],
      final_segment_drive_minutes: 312,
    }));

    expect(result.verdict).toBe('fits');
    expect(result.recommended_allocation).not.toBeNull();
    expect(result.recommended_allocation!.recommended_nights).toEqual([4]);
  });

  it('multiple flex waypoints with deadline', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1, 1],
      waypoint_nights: [2, 3],
      time_budget_days: null,
      flexible_waypoints: [
        { name: 'City A', min_nights: 1, preferred_nights: 3 },
        { name: 'City B', min_nights: 1, preferred_nights: 5 },
      ],
      arrival_deadline: {
        datetime: '2026-06-10T18:00:00+02:00',
        local_time: '18:00',
        buffer_minutes: 60,
      },
      departure_date: '2026-06-01',
      segment_drive_minutes: [300, 200, 180],
      final_segment_drive_minutes: 180,
    }));

    expect(result.recommended_allocation).not.toBeNull();
    const nights = result.recommended_allocation!.recommended_nights;
    expect(nights[0] + nights[1]).toBe(6);
    expect(nights[1]).toBeGreaterThan(nights[0]);
  });
});
