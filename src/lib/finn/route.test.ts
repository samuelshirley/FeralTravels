import { describe, it, expect } from 'vitest';
import { cumulativeDistancesKm, projectPointOntoRoute } from './route';
import { polylineLengthKm, type LatLng } from '@/lib/polyline';

// Straight eastward route at 51°N.
const route: LatLng[] = [
  { lat: 51.0, lng: 7.0 },
  { lat: 51.0, lng: 7.2 },
  { lat: 51.0, lng: 7.4 },
];

describe('cumulativeDistancesKm', () => {
  it('starts at 0 and is monotonic, ending at total length', () => {
    const cum = cumulativeDistancesKm(route);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(0);
    expect(cum[2]).toBeGreaterThan(cum[1]);
    expect(cum[2]).toBeCloseTo(polylineLengthKm(route), 6);
  });
});

describe('projectPointOntoRoute', () => {
  it('a point on the route projects with ~0 perpendicular distance', () => {
    const onRoute: LatLng = { lat: 51.0, lng: 7.1 };
    const proj = projectPointOntoRoute(onRoute, route);
    expect(proj.perpKm).toBeLessThan(0.01);
    // Halfway through the first segment.
    const cum = cumulativeDistancesKm(route);
    expect(proj.alongKm).toBeCloseTo(cum[1] / 2, 1);
    expect(proj.segmentIndex).toBe(0);
  });

  it('an off-route point reports the perpendicular offset and nearest along-distance', () => {
    // ~north of the second vertex.
    const off: LatLng = { lat: 51.05, lng: 7.2 };
    const proj = projectPointOntoRoute(off, route);
    const cum = cumulativeDistancesKm(route);
    expect(proj.perpKm).toBeGreaterThan(4); // ~5.5 km north
    expect(proj.perpKm).toBeLessThan(7);
    expect(proj.alongKm).toBeCloseTo(cum[1], 0); // nearest the middle vertex
  });

  it('picks the nearest segment when the point is closer to a later one', () => {
    const nearEnd: LatLng = { lat: 51.0, lng: 7.38 };
    const proj = projectPointOntoRoute(nearEnd, route);
    expect(proj.segmentIndex).toBe(1);
  });

  it('passing precomputed cumulative gives the same answer', () => {
    const p: LatLng = { lat: 51.02, lng: 7.25 };
    const cum = cumulativeDistancesKm(route);
    expect(projectPointOntoRoute(p, route, cum)).toEqual(projectPointOntoRoute(p, route));
  });
});
