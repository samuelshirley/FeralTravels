import { describe, it, expect } from 'vitest';
import { computePlanSummary } from './planSummary';
import type { LegConstraint, LegType, LegWithDetails } from '@/types/trip';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let legSeq = 0;

/** Minimal LegWithDetails factory — only the fields computePlanSummary reads. */
function mkLeg(partial: {
  leg_type: LegType;
  date_iso: string;
  start_name?: string | null;
  end_name?: string | null;
  distance_km?: number | null;
  drive_time_minutes?: number | null;
  constraints?: LegConstraint[];
}): LegWithDetails {
  const id = `leg-${legSeq++}`;
  return {
    id,
    range_remaining_start_km: null,
    trip_id: 'trip-1',
    sort_order: legSeq,
    leg_type: partial.leg_type,
    title: partial.leg_type === 'drive' ? 'Drive' : 'Rest day',
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: partial.start_name ?? null,
    end_name: partial.end_name ?? null,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
    dates: null,
    date_iso: partial.date_iso,
    distance_km: partial.distance_km ?? null,
    drive_time_minutes: partial.drive_time_minutes ?? null,
    terrain: null,
    overnight: null,
    status: 'planning',
    color: null,
    notes: null,
    fuel_status: 'none',
    fuel_plan_error: null,
    fuel_stops_updated_at: null,
    continuity_warning: null,
    geometry: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    costs: [],
    links: [],
    routes: [],
    stops: [],
    tasks: [],
    constraints: partial.constraints ?? [],
    parsedNotes: [],
  };
}

function arriveBy(datetime: string): LegConstraint {
  return {
    id: `c-${legSeq++}`,
    leg_id: 'x',
    constraint_type: 'arrive_by',
    constraint_datetime: datetime,
    buffer_minutes: 60,
    note: null,
    created_at: '2026-05-01T00:00:00.000Z',
  };
}

/**
 * The Girona → Innsbruck (3 nights) → Bad Kissingen scenario that exposed the
 * hallucination: trip departs 2026-05-29, two drive days to Innsbruck, three
 * rest nights there, final drive into Bad Kissingen on 2026-06-03 — the
 * deadline day. Penny had claimed "2 nights instead of 3" and "arriving Jun 2
 * at 1:47pm"; the deterministic summary must contradict both.
 */
function gironaToBadKissingen(deadlineDatetime: string | null): LegWithDetails[] {
  legSeq = 0;
  return [
    mkLeg({ leg_type: 'drive', date_iso: '2026-05-29', start_name: 'Girona', end_name: 'Montpellier', distance_km: 350, drive_time_minutes: 240 }),
    mkLeg({ leg_type: 'drive', date_iso: '2026-05-30', start_name: 'Montpellier', end_name: 'Innsbruck', distance_km: 500, drive_time_minutes: 360 }),
    mkLeg({ leg_type: 'rest', date_iso: '2026-05-31', start_name: 'Innsbruck', end_name: 'Innsbruck' }),
    mkLeg({ leg_type: 'rest', date_iso: '2026-06-01', start_name: 'Innsbruck', end_name: 'Innsbruck' }),
    mkLeg({ leg_type: 'rest', date_iso: '2026-06-02', start_name: 'Innsbruck', end_name: 'Innsbruck' }),
    mkLeg({
      leg_type: 'drive',
      date_iso: '2026-06-03',
      start_name: 'Innsbruck',
      end_name: 'Bad Kissingen',
      distance_km: 460,
      drive_time_minutes: 312,
      constraints: deadlineDatetime ? [arriveBy(deadlineDatetime)] : [],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computePlanSummary', () => {
  it('returns null when there are no legs', () => {
    expect(computePlanSummary({ legs: [], tripStartISO: '2026-05-29' })).toBeNull();
  });

  it('counts drive/rest days and totals from the persisted legs', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(null),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.total_days).toBe(6);
    expect(s.drive_days).toBe(3);
    expect(s.rest_days).toBe(3);
    expect(s.total_distance_km).toBe(1310);
    expect(s.total_drive_minutes).toBe(912);
  });

  it('reports depart and arrive from the first leg and final drive', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(null),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.depart_name).toBe('Girona');
    expect(s.depart_date_iso).toBe('2026-05-29');
    expect(s.arrive_name).toBe('Bad Kissingen');
    expect(s.arrive_date_iso).toBe('2026-06-03');
  });

  it('attributes nights to the waypoint, not the destination — refutes the "2 nights" hallucination', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(null),
      tripStartISO: '2026-05-29',
    })!;
    // Montpellier (0-night overnight) is excluded; Innsbruck has all 3 nights.
    expect(s.nights_per_stop).toEqual([{ name: 'Innsbruck', nights: 3 }]);
  });

  it('defaults departure to 08:00 and estimates the final ETA from the day model', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(null),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.depart_time).toBe('08:00');
    // 312 drive min + round(312/60*10)=52 break min + 30 setup = 394; 08:00 + 394 = 14:34
    expect(s.arrive_time).toBe('14:34');
  });

  it('marks a same-day arrival against the deadline as same_day with a clock check', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen('2026-06-03T15:00:00+02:00'),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.deadline).not.toBeNull();
    expect(s.deadline!.date_iso).toBe('2026-06-03');
    expect(s.deadline!.local_time).toBe('15:00');
    expect(s.deadline!.status).toBe('same_day');
    expect(s.deadline!.buffer_days).toBe(0);
    // ETA 14:34 vs a 15:00 deadline = 26 min raw slack — inside the 1h buffer, so "tight".
    expect(s.deadline!.same_day_clock).not.toBeNull();
    expect(s.deadline!.same_day_clock!.eta).toBe('14:34');
    expect(s.deadline!.same_day_clock!.slack_minutes).toBe(26);
    expect(s.deadline!.same_day_clock!.clears_buffer).toBe(false);
  });

  it('clears the buffer when the same-day ETA beats the deadline by over an hour', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen('2026-06-03T18:00:00+02:00'),
      tripStartISO: '2026-05-29',
    })!;
    // ETA 14:34 vs 18:00 deadline = 206 min raw slack — clears the 1h buffer.
    expect(s.deadline!.same_day_clock!.clears_buffer).toBe(true);
    expect(s.deadline!.same_day_clock!.slack_minutes).toBe(206);
  });

  it('reports buffer days when arrival is before the deadline (no same-day clock)', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen('2026-06-05T15:00:00+02:00'),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.deadline!.status).toBe('before');
    expect(s.deadline!.buffer_days).toBe(2);
    expect(s.deadline!.local_time).toBe('15:00');
    expect(s.deadline!.same_day_clock).toBeNull();
  });

  it('flags a missed deadline as after with negative buffer (no same-day clock)', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen('2026-06-02T15:00:00+02:00'),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.deadline!.status).toBe('after');
    expect(s.deadline!.buffer_days).toBe(-1);
    expect(s.deadline!.same_day_clock).toBeNull();
  });

  it('omits the deadline block when no leg carries an arrive_by constraint', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(null),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.deadline).toBeNull();
  });
});
