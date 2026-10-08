/**
 * Tests for pickNearestNewLeg — the resolver that maps an invented leg_id onto
 * a leg created in the SAME replan turn (new legs have no real UUID until
 * dispatch, so Penny guesses one for add_stop/add_route).
 *
 * Regression target: Gabe's "July '26 Trip" rebuild deleted 9 legs and added 5
 * in one turn, then tried to attach a "Rockaway Beach" stop to the brand-new
 * first leg. The stop's leg_id didn't resolve and the stop was silently dropped
 * with "add_stop: Leg not found".
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { pickNearestNewLeg, type NewLegRecord } from './newLegFallback';

// Five new legs roughly tracing Portland → Mt Rainier → Olympic → Seattle,
// mirroring the rebuild turn that triggered the bug.
const portlandToRainier: NewLegRecord = {
  id: 'leg-pdx-rainier',
  startLat: 45.5152,
  startLng: -122.6784,
  endLat: 46.748,
  endLng: -121.9018,
};
const rainierRest: NewLegRecord = {
  id: 'leg-rainier-rest',
  startLat: 46.748,
  startLng: -121.9018,
  endLat: 46.748,
  endLng: -121.9018,
};
const rainierToOlympic: NewLegRecord = {
  id: 'leg-rainier-olympic',
  startLat: 46.748,
  startLng: -121.9018,
  endLat: 48.1014,
  endLng: -123.4307,
};
const allNewLegs = [portlandToRainier, rainierRest, rainierToOlympic];

describe('pickNearestNewLeg', () => {
  it('returns null when no leg was created this turn', () => {
    expect(pickNearestNewLeg({ lat: 45.6, lng: -123.9 }, [])).toBeNull();
  });

  it('lands a coastal Rockaway Beach stop on the Portland→Rainier corridor', () => {
    // Rockaway Beach, OR — the actual stop Penny promised but never saved.
    const rockawayBeach = { lat: 45.6137, lng: -123.9426 };
    expect(pickNearestNewLeg(rockawayBeach, allNewLegs)).toBe('leg-pdx-rainier');
  });

  it('picks the geographically nearest corridor, not just the first leg', () => {
    // A point up on the Olympic Peninsula should bind to the Rainier→Olympic leg.
    const hurricaneRidge = { lat: 47.9694, lng: -123.4983 };
    expect(pickNearestNewLeg(hurricaneRidge, allNewLegs)).toBe('leg-rainier-olympic');
  });

  it('falls back to the first new leg when the item has no coordinate', () => {
    expect(pickNearestNewLeg({ lat: null, lng: null }, allNewLegs)).toBe('leg-pdx-rainier');
    expect(pickNearestNewLeg(null, allNewLegs)).toBe('leg-pdx-rainier');
  });

  it('falls back to the first new leg when no new leg has coordinates', () => {
    const coordless: NewLegRecord[] = [
      { id: 'a', startLat: null, startLng: null, endLat: null, endLng: null },
      { id: 'b', startLat: null, startLng: null, endLat: null, endLng: null },
    ];
    expect(pickNearestNewLeg({ lat: 45.6, lng: -123.9 }, coordless)).toBe('a');
  });

  it('does not consume legs — repeated calls are stable (multiple stops share a leg)', () => {
    const p = { lat: 45.6137, lng: -123.9426 };
    expect(pickNearestNewLeg(p, allNewLegs)).toBe('leg-pdx-rainier');
    expect(pickNearestNewLeg(p, allNewLegs)).toBe('leg-pdx-rainier');
  });
});

import {
  pickSameTurnRestLeg,
  nearbySameTurnRestLegs,
  REST_DAY_STOP_RADIUS_KM,
  type LegEnds,
} from './newLegFallback';
import { haversineKm } from './geo';

/**
 * The 2026-10-07 local IOS_AI=1 run of penny-rest-day.yaml: asked for "one rest
 * day in Strasbourg right after day 1, with Strasbourg Cathedral as a stop",
 * Penny added the base day (start == end, Strasbourg) and then add_stop'd the
 * cathedral onto the EXISTING Strasbourg → Stuttgart leg — the only real
 * Strasbourg leg she knew — because the new base day had no id yet.
 */
describe('pickSameTurnRestLeg — a stop meant for this turn\'s rest day', () => {
  const STRASBOURG = { lat: 48.5734, lng: 7.7521 };
  const CATHEDRAL = { lat: 48.5818, lng: 7.7509 };
  const newRestDay: NewLegRecord = {
    id: 'new-base-day-strasbourg',
    startLat: STRASBOURG.lat,
    startLng: STRASBOURG.lng,
    endLat: STRASBOURG.lat,
    endLng: STRASBOURG.lng,
  };
  // The real, pre-existing day 2 the stop landed on (9bff… in the local DB).
  const strasbourgToStuttgart: LegEnds = {
    id: '9bff-existing-day-2',
    startLat: STRASBOURG.lat,
    startLng: STRASBOURG.lng,
    endLat: 48.7758,
    endLng: 9.1829,
  };
  const parisToStrasbourg: LegEnds = {
    id: 'existing-day-1',
    startLat: 48.8566,
    startLng: 2.3522,
    endLat: STRASBOURG.lat,
    endLng: STRASBOURG.lng,
  };

  it('the fixture is the real geometry: the cathedral is ~0.9 km from the base day', () => {
    const km = haversineKm(CATHEDRAL.lat, CATHEDRAL.lng, STRASBOURG.lat, STRASBOURG.lng);
    expect(km).toBeGreaterThan(0.8);
    expect(km).toBeLessThan(1.1);
  });

  it('(a) re-homes the cathedral from Strasbourg → Stuttgart onto the new base day', () => {
    expect(pickSameTurnRestLeg(CATHEDRAL, strasbourgToStuttgart, [newRestDay])).toBe(newRestDay.id);
  });

  it('re-homes from the day that ENDS in the town too (the day before the stay)', () => {
    expect(pickSameTurnRestLeg(CATHEDRAL, parisToStrasbourg, [newRestDay])).toBe(newRestDay.id);
  });

  it('(b) leaves a stop alone when no rest day was created this turn', () => {
    expect(pickSameTurnRestLeg(CATHEDRAL, strasbourgToStuttgart, [])).toBeNull();
    // A new DRIVE leg this turn is not a stay.
    const newDrive: NewLegRecord = { id: 'new-drive', startLat: 48.5734, startLng: 7.7521, endLat: 48.0794, endLng: 7.3585 };
    expect(pickSameTurnRestLeg(CATHEDRAL, strasbourgToStuttgart, [newDrive])).toBeNull();
  });

  it('(c) leaves it alone when this turn\'s rest day is in another town (Colmar)', () => {
    const colmarRest: NewLegRecord = { id: 'new-base-day-colmar', startLat: 48.0794, startLng: 7.3585, endLat: 48.0794, endLng: 7.3585 };
    expect(pickSameTurnRestLeg(CATHEDRAL, strasbourgToStuttgart, [colmarRest])).toBeNull();
  });

  it('(d) leaves a stop 80 km down the onward road where Penny put it', () => {
    const pforzheim = { lat: 48.8922, lng: 8.6946 };
    expect(haversineKm(pforzheim.lat, pforzheim.lng, STRASBOURG.lat, STRASBOURG.lng)).toBeGreaterThan(60);
    expect(pickSameTurnRestLeg(pforzheim, strasbourgToStuttgart, [newRestDay])).toBeNull();
  });

  it('leaves it alone when the named leg does not touch the town', () => {
    const lyonToDijon: LegEnds = { id: 'existing-lyon-dijon', startLat: 45.764, startLng: 4.8357, endLat: 47.322, endLng: 5.0415 };
    expect(pickSameTurnRestLeg(CATHEDRAL, lyonToDijon, [newRestDay])).toBeNull();
  });

  it('leaves it alone when the named leg is itself an existing rest day in that town', () => {
    const existingRest: LegEnds = { id: 'existing-base-day', startLat: STRASBOURG.lat, startLng: STRASBOURG.lng, endLat: STRASBOURG.lat, endLng: STRASBOURG.lng };
    expect(pickSameTurnRestLeg(CATHEDRAL, existingRest, [newRestDay])).toBeNull();
  });

  it('leaves a stop with no coordinate alone', () => {
    expect(pickSameTurnRestLeg({ lat: null, lng: null }, strasbourgToStuttgart, [newRestDay])).toBeNull();
  });

  it('nearbySameTurnRestLegs is empty beyond the radius, so the caller skips its read', () => {
    expect(nearbySameTurnRestLegs(CATHEDRAL, [newRestDay])).toHaveLength(1);
    const farPoint = { lat: STRASBOURG.lat + (REST_DAY_STOP_RADIUS_KM + 1) / 111, lng: STRASBOURG.lng };
    expect(nearbySameTurnRestLegs(farPoint, [newRestDay])).toHaveLength(0);
  });
});
