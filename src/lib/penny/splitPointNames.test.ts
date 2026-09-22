import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import fixture from './__fixtures__/girona-annecy.json';
import { formatPlaceLabel, settlementRank, type PlaceLookup } from '../osm/nominatim';
import type { LookupFn } from './splitPointNames';

const { planSplitIndices, legsFromSplitIndices } = await import('./split-route');
const { nameSplitPoints } = await import('./splitPointNames');

/**
 * THE REPORTED TRIP, with its real geometry and real Nominatim answers.
 *
 * Girona → Annecy at a 4 h daily cap, 2026-09-21: the plan came back as
 * "Girona → Tavel" / "Tavel → Annecy". Everything about that was individually
 * correct — the split is the halfway point and Tavel is its nearest settlement
 * — and the itinerary was still useless, which is why the fix is a snap and not
 * a prompt.
 *
 * The polyline is OSRM's (free, test-only; production routes on Google
 * Directions) downsampled to ~1 point per 3 km. `lookups` are live Nominatim
 * answers keyed by polyline index. A lookup for an index that was never
 * captured THROWS rather than returning null: a silent null would let a change
 * in probe order quietly turn this into a test of nothing.
 */
const CAP_MINUTES = 4 * 60;

const lookups = fixture.lookups as Record<
  string,
  { name: string | null; address: Record<string, string> }
>;

function indexOfPoint(lat: number, lng: number): number {
  const i = (fixture.polyline_points as number[][]).findIndex(
    (p) => p[0] === lat && p[1] === lng,
  );
  if (i < 0) throw new Error(`point not on the fixture polyline: ${lat},${lng}`);
  return i;
}

const captured: LookupFn = async (lat, lng): Promise<PlaceLookup> => {
  const i = indexOfPoint(lat, lng);
  const hit = lookups[String(i)];
  if (!hit) throw new Error(`no captured Nominatim answer for polyline index ${i}`);
  return { label: formatPlaceLabel(hit.name, hit.address), rank: settlementRank(hit.address) };
};

function plan() {
  const p = planSplitIndices({
    polyline_points: fixture.polyline_points as Array<[number, number]>,
    total_distance_km: fixture.total_distance_km,
    total_drive_time_minutes: fixture.total_drive_time_minutes,
    max_drive_minutes_per_day: CAP_MINUTES,
  });
  if (!p) throw new Error('no plan');
  return p;
}

describe('nameSplitPoints — the Girona → Annecy regression', () => {
  it('plans the split where the bug reported it: a village', () => {
    const p = plan();
    expect(p.indices).toHaveLength(2);
    expect(p.indices[0]).toBe(fixture.planned_split_index);

    const atPlanned = lookups[String(fixture.planned_split_index)];
    expect(settlementRank(atPlanned.address)).toBe('village');
  });

  it('moves the overnight to the nearest town along the route', async () => {
    const named = await nameSplitPoints(plan(), captured);

    expect(named[0].name).toBe('Orange, France');
    expect(named[0].rank).toBe('town');
    // Forward, because forward is nearer — Nîmes (a city) sits 17 minutes back
    // and the smaller detour wins over the bigger settlement.
    expect(named[0].moved_minutes).toBeGreaterThan(0);
    expect(named[0].moved_minutes).toBeLessThanOrEqual(25);
  });

  it('names the destination and never moves it', async () => {
    const p = plan();
    const named = await nameSplitPoints(p, captured);
    const last = named[named.length - 1];

    expect(last.index).toBe(p.indices[p.indices.length - 1]);
    expect(last.moved_minutes).toBe(0);
    expect(last.name).toBe('Annecy, France');
  });

  it('keeps both days under the cap after the move', async () => {
    const p = plan();
    const named = await nameSplitPoints(p, captured);
    const legs = legsFromSplitIndices(p, named.map((n) => n.index));

    expect(legs).toHaveLength(2);
    for (const leg of legs) expect(leg.drive_time_minutes).toBeLessThanOrEqual(CAP_MINUTES);
    // The move is paid for out of day 1 and refunded to day 2.
    expect(legs[0].drive_time_minutes).toBeGreaterThan(legs[1].drive_time_minutes);
    expect(legs[0].distance_km + legs[1].distance_km).toBeCloseTo(fixture.total_distance_km, 0);
  });

  it('spends one call on the split and one on the destination when it finds a town first try', async () => {
    const named = await nameSplitPoints(plan(), captured);
    // planned (village) + one probe that hits Orange.
    expect(named[0].probes).toBe(2);
    expect(named[1].probes).toBe(1);
  });
});

describe('nameSplitPoints — constraints', () => {
  it('does not move at all when the planned split is already a town or city', async () => {
    const p = plan();
    // Pretend every point is Orange: the planned split now qualifies on the
    // first probe, so there is nothing to look for.
    const allTowns: LookupFn = async () => ({ label: 'Somewhere, France', rank: 'town' });
    const named = await nameSplitPoints(p, allTowns);

    expect(named[0].index).toBe(p.indices[0]);
    expect(named[0].moved_minutes).toBe(0);
    expect(named[0].probes).toBe(1);
  });

  it('keeps the planned split when nothing within tolerance is big enough', async () => {
    const p = plan();
    const allVillages: LookupFn = async () => ({ label: 'Tavel, France', rank: 'village' });
    const named = await nameSplitPoints(p, allVillages);

    expect(named[0].index).toBe(p.indices[0]);
    expect(named[0].name).toBe('Tavel, France');
    expect(named[0].moved_minutes).toBe(0);
  });

  it('respects max_probes', async () => {
    const p = plan();
    let calls = 0;
    const counting: LookupFn = async () => {
      calls++;
      return { label: 'Nowhere', rank: 'village' };
    };
    await nameSplitPoints(p, counting, { max_probes: 2 });
    // 2 on the split, 1 on the destination (which is never probed past the first).
    expect(calls).toBe(3);
  });

  it('will not move a split past the daily cap', async () => {
    const p = plan();
    // A cap only just above the planned day leaves no forward room at all.
    const tight = { ...p, max_drive_minutes_per_day: Math.round(p.total_drive_time_minutes / 2) + 1 };
    const townsOnlyAhead: LookupFn = async (lat, lng) =>
      indexOfPoint(lat, lng) > fixture.planned_split_index
        ? { label: 'Far Town', rank: 'town' }
        : { label: 'Here Village', rank: 'village' };

    const named = await nameSplitPoints(tight, townsOnlyAhead, { tolerance_minutes: 60 });
    const legs = legsFromSplitIndices(tight, named.map((n) => n.index));
    for (const leg of legs) {
      expect(leg.drive_time_minutes).toBeLessThanOrEqual(tight.max_drive_minutes_per_day);
    }
  });

  it('degrades to unnamed splits rather than throwing when there is no geometry', async () => {
    const empty = { ...plan(), polyline_points: [], cumulative_km: [], polyline_total_km: 0 };
    const named = await nameSplitPoints(empty, async () => {
      throw new Error('must not be called');
    });
    expect(named.every((n) => n.name === null)).toBe(true);
  });
});
