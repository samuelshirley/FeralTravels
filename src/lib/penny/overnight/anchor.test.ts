/**
 * Tests for the distance-anchoring geometry. Pure function — no DB, no network.
 *
 * The fixture polyline runs west→east along the equator, so 1° of longitude
 * is ~111.32 km and the math is easy to reason about.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { computeOvernightWindow, type LatLng } from './anchor';

// Equator, lng 0 → 4. Each 1° step ≈ 111.32 km; total ≈ 445 km.
const EQUATOR_ROUTE: LatLng[] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
];

describe('computeOvernightWindow', () => {
  it('anchors at the target distance along the route', () => {
    const w = computeOvernightWindow({ polyline: EQUATOR_ROUTE, targetKm: 222 });
    // ~222 km ≈ 2° of longitude.
    expect(w.anchor[0]).toBeCloseTo(0, 5);
    expect(w.anchor[1]).toBeCloseTo(2, 1);
    expect(w.anchorKm).toBeCloseTo(222, 0);
    expect(w.routeKm).toBeGreaterThan(440);
    expect(w.routeKm).toBeLessThan(450);
  });

  it('builds a window centred on the anchor and a bbox that contains it', () => {
    const w = computeOvernightWindow({
      polyline: EQUATOR_ROUTE,
      targetKm: 222,
      windowHalfWidthKm: 30,
      corridorHalfWidthKm: 3,
    });
    expect(w.windowStartKm).toBeCloseTo(192, 0);
    expect(w.windowEndKm).toBeCloseTo(252, 0);

    // bbox must contain the anchor and every window-polyline point.
    expect(w.anchor[0]).toBeGreaterThanOrEqual(w.bbox.south);
    expect(w.anchor[0]).toBeLessThanOrEqual(w.bbox.north);
    expect(w.anchor[1]).toBeGreaterThanOrEqual(w.bbox.west);
    expect(w.anchor[1]).toBeLessThanOrEqual(w.bbox.east);
    for (const [lat, lng] of w.windowPolyline) {
      expect(lat).toBeGreaterThanOrEqual(w.bbox.south);
      expect(lat).toBeLessThanOrEqual(w.bbox.north);
      expect(lng).toBeGreaterThanOrEqual(w.bbox.west);
      expect(lng).toBeLessThanOrEqual(w.bbox.east);
    }
  });

  it('clamps the anchor to the route end when target exceeds route length', () => {
    const w = computeOvernightWindow({ polyline: EQUATOR_ROUTE, targetKm: 10_000 });
    expect(w.anchorKm).toBeCloseTo(w.routeKm, 5);
    expect(w.anchor[1]).toBeCloseTo(4, 5);
    expect(w.windowEndKm).toBeCloseTo(w.routeKm, 5);
  });

  it('clamps the window start at the route origin', () => {
    const w = computeOvernightWindow({
      polyline: EQUATOR_ROUTE,
      targetKm: 10,
      windowHalfWidthKm: 30,
    });
    expect(w.windowStartKm).toBe(0);
  });

  it('throws on a degenerate polyline', () => {
    expect(() => computeOvernightWindow({ polyline: [[0, 0]], targetKm: 5 })).toThrow();
  });

  it('throws on a non-positive target', () => {
    expect(() =>
      computeOvernightWindow({ polyline: EQUATOR_ROUTE, targetKm: 0 })
    ).toThrow();
  });
});
