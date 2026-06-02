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
