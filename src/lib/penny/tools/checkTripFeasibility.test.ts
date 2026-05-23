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

// ---------------------------------------------------------------------------
// Calendar-anchor constraint checks — the "leave on the 3rd" fix
// ---------------------------------------------------------------------------

describe('computeFeasibility (calendar-anchor constraints)', () => {
  // Girona → Lyon → Innsbruck → Bad Kissingen. Depart May 29 (2 driving days
  // before the Bad Kissingen leg), must leave Innsbruck the morning of June 3.
  const badKissingenConstraint = (cumulativeRestDays: number) => ({
    label: 'Leave Innsbruck for Bad Kissingen on Jun 3',
    leg_index: 5,
    constraint_type: 'depart_after' as const,
    datetime: '2026-06-03T08:00:00+02:00',
    buffer_minutes: 60,
    cumulative_drive_minutes: 1090,
    cumulative_drive_days: 2,
    cumulative_rest_days: cumulativeRestDays,
    departure_datetime: '2026-05-29T08:00:00+02:00',
  });

  it('flags Penny\'s 1-rest-day plan and prescribes 3', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1, 1],
      waypoint_nights: [1],
      time_budget_days: null,
      constraint_checks: [badKissingenConstraint(1)],
    }));
    const c = result.constraint_results[0];
    expect(c.status).toBe('fail');
    expect(c.required_rest_days_before).toBe(3);
    expect(c.detail).toContain('add 2');
    expect(result.feasible).toBe(false);
  });

  it('passes when 3 rest days are planned (lands on Jun 3)', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1, 1],
      waypoint_nights: [3],
      time_budget_days: null,
      constraint_checks: [badKissingenConstraint(3)],
    }));
    const c = result.constraint_results[0];
    expect(c.status).toBe('pass');
    expect(c.required_rest_days_before).toBe(3);
    expect(c.detail).toContain('2026-06-03');
  });

  it('fails with a negative count when the fixed date is too early', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1, 1],
      waypoint_nights: [0],
      time_budget_days: null,
      constraint_checks: [{
        label: 'Arrive too soon',
        leg_index: 1,
        constraint_type: 'arrive_by',
        datetime: '2026-05-30T12:00:00+02:00',
        buffer_minutes: 60,
        cumulative_drive_minutes: 1500,
        cumulative_drive_days: 3, // 3 drives can't fit before May 30
        cumulative_rest_days: 0,
        departure_datetime: '2026-05-29T08:00:00+02:00',
      }],
    }));
    const c = result.constraint_results[0];
    expect(c.status).toBe('fail');
    expect(c.required_rest_days_before).toBeLessThan(0);
  });

  it('leaves clock-time arrive_by behavior intact when no cumulative_drive_days', () => {
    const result = computeFeasibility(feasInput({
      segment_drive_days: [1],
      waypoint_nights: [],
      time_budget_days: null,
      constraint_checks: [{
        label: 'Arrive by 3pm',
        leg_index: 0,
        constraint_type: 'arrive_by',
        datetime: '2026-05-29T15:00:00+02:00',
        buffer_minutes: 60,
        cumulative_drive_minutes: 180,
        cumulative_rest_days: 0,
        departure_datetime: '2026-05-29T08:00:00+02:00',
      }],
    }));
    const c = result.constraint_results[0];
    // Clock-time path (not calendar-anchor): 8am + 3h drive + breaks + setup ≈
    // noon, leaving ~2h before the 3pm−1h-buffer deadline → 'at_risk'. The key
    // assertion is that the anchor field stays unset, proving we took the
    // legacy clock branch, not the new calendar branch.
    expect(c.status).toBe('at_risk');
    expect(c.required_rest_days_before == null).toBe(true);
  });
});
