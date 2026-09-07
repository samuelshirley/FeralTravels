import { describe, it, expect } from 'vitest';
import { computePlanSummary } from './planSummary';
import type { LegType, LegWithDetails } from '@/types/trip';

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
    parsedNotes: [],
  };
}

/**
 * The Girona → Innsbruck (3 nights) → Bad Kissingen scenario that exposed the
 * hallucination: trip departs 2026-05-29, two drive days to Innsbruck, three
 * rest nights there, final drive into Bad Kissingen on 2026-06-03 — the
 * deadline day. Penny had claimed "2 nights instead of 3" and "arriving Jun 2
 * at 1:47pm"; the deterministic summary must contradict both.
 */
function gironaToBadKissingen(): LegWithDetails[] {
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
      legs: gironaToBadKissingen(),
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
      legs: gironaToBadKissingen(),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.depart_name).toBe('Girona');
    expect(s.depart_date_iso).toBe('2026-05-29');
    expect(s.arrive_name).toBe('Bad Kissingen');
    expect(s.arrive_date_iso).toBe('2026-06-03');
  });

  it('attributes nights to the waypoint, not the destination — refutes the "2 nights" hallucination', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(),
      tripStartISO: '2026-05-29',
    })!;
    // Montpellier (0-night overnight) is excluded; Innsbruck has all 3 nights.
    expect(s.nights_per_stop).toEqual([{ name: 'Innsbruck', nights: 3 }]);
  });

  it('defaults departure to 08:00 and estimates the final ETA from the day model', () => {
    const s = computePlanSummary({
      legs: gironaToBadKissingen(),
      tripStartISO: '2026-05-29',
    })!;
    expect(s.depart_time).toBe('08:00');
    // 312 drive min + round(312/60*10)=52 break min + 30 setup = 394; 08:00 + 394 = 14:34
    expect(s.arrive_time).toBe('14:34');
  });

});
