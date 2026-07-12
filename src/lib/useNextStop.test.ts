import { describe, it, expect } from 'vitest';
import { pickNextStop, segmentDestinations } from './useNextStop';
import type { NavSegment } from './maps';

// Trip d0b5741b geometry (the smart-nav incident): Puoltikasvaara → Gammelstad
// with a fuel stop at Överkalix. Coordinates are the real prod values.
const LEG_START = { lat: 67.479858, lng: 21.11667 }; // Puoltikasvaara
const FUEL = { lat: 66.2588625, lng: 22.8164849 }; // Circle K, ~181 km in
const DEST = { lat: 65.64777, lng: 22.02833 }; // Rutviksvägen 40, Gammelstad

function seg(name: string, p: { lat: number; lng: number }, stopType?: string): NavSegment {
  return {
    label: name,
    stopType,
    url: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving&dir_action=navigate`,
  };
}

const SEGMENTS: NavSegment[] = [seg('Circle K', FUEL, 'fuel'), seg('Gammelstad', DEST, 'destination')];
const DESTS = segmentDestinations(SEGMENTS);

describe('segmentDestinations', () => {
  it('extracts destination coords from segment URLs in order', () => {
    expect(DESTS).toEqual([FUEL, DEST]);
  });

  it('skips segments with unparseable URLs or missing destination', () => {
    const mixed: NavSegment[] = [
      { label: 'bad', url: 'not-a-url' },
      { label: 'no-dest', url: 'https://maps.google.com/maps/dir/?api=1' },
      seg('ok', DEST),
    ];
    expect(segmentDestinations(mixed)).toEqual([DEST]);
  });
});

describe('pickNextStop', () => {
  it('at the leg start → next stop is the fuel stop (first unreached)', () => {
    const r = pickNextStop(SEGMENTS, DESTS, LEG_START, LEG_START);
    expect(r.isNearRoute).toBe(true);
    expect(r.nextStop?.label).toBe('Circle K');
  });

  it('after passing the fuel stop → next stop flips to the destination', () => {
    // 1 km past the fuel stop is still within its 2 km arrival radius → still
    // "at" the fuel stop; the walk should move on to the destination once
    // outside the radius. Test a point ~30 km beyond the fuel stop.
    const past = { lat: 66.0, lng: 22.7 };
    const r = pickNextStop(SEGMENTS, DESTS, past, LEG_START);
    expect(r.isNearRoute).toBe(true);
    expect(r.nextStop?.label).toBe('Circle K'); // >2km from fuel → fuel still next
    const within = { lat: 66.26, lng: 22.815 }; // ~150 m from the fuel stop
    const r2 = pickNextStop(SEGMENTS, DESTS, within, LEG_START);
    expect(r2.nextStop?.label).toBe('Gammelstad'); // arrived at fuel → destination next
  });

  it('arrived at the destination → shows the final destination', () => {
    const r = pickNextStop(SEGMENTS, DESTS, DEST, LEG_START);
    expect(r.isNearRoute).toBe(true);
    // Fuel stop is ~100 km away (unreached) so the walk returns it — the
    // driver skipped it. This documents current behavior: route-order walk,
    // not nearest-first.
    expect(r.nextStop?.label).toBe('Circle K');
  });

  it('far from everything → not near route (caller shows the full list)', () => {
    const stockholm = { lat: 59.33, lng: 18.06 };
    const r = pickNextStop(SEGMENTS, DESTS, stockholm, LEG_START);
    expect(r.isNearRoute).toBe(false);
    expect(r.nextStop).toBeNull();
  });

  it('near leg start but >50km from every destination still counts as near route', () => {
    // legStart is included in the near-route check.
    const nearStart = { lat: 67.5, lng: 21.2 };
    const r = pickNextStop(SEGMENTS, DESTS, nearStart, LEG_START);
    expect(r.isNearRoute).toBe(true);
  });

  it('empty segments → nothing', () => {
    expect(pickNextStop([], [], LEG_START, LEG_START)).toEqual({
      nextStop: null,
      isNearRoute: false,
    });
  });

  it('within arrival radius of every stop → final destination', () => {
    const single = [seg('Only', DEST)];
    const r = pickNextStop(single, segmentDestinations(single), DEST, null);
    expect(r.nextStop?.label).toBe('Only');
    expect(r.isNearRoute).toBe(true);
  });
});
