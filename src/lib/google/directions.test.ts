import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  concatStepPolylines,
  decodePolyline,
  POLYLINE_SIMPLIFY_TOLERANCE_M,
  simplifyPolyline,
} from './directions';

// ---------------------------------------------------------------------------
// Test helper: encode [lat, lng] pairs into Google's polyline format so we
// can build realistic step fixtures. Inverse of decodePolyline.
// ---------------------------------------------------------------------------

function encodePolyline(points: Array<[number, number]>): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const encodeValue = (v: number): string => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let chunk = '';
    while (value >= 0x20) {
      chunk += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    chunk += String.fromCharCode(value + 63);
    return chunk;
  };
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    out += encodeValue(latE5 - prevLat) + encodeValue(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return out;
}

/** Wrap point lists into the Directions `legs[].steps[]` response shape. */
function legOfSteps(...stepPoints: Array<Array<[number, number]>>) {
  return {
    steps: stepPoints.map((pts) => ({ polyline: { points: encodePolyline(pts) } })),
  };
}

/**
 * Normalize expected points through the decoder's exact arithmetic
 * (round to 1e-5 integer, multiply back) so float artefacts like
 * 63.510000000000005 compare equal.
 */
function q(pts: Array<[number, number]>): Array<[number, number]> {
  return pts.map(([lat, lng]) => [
    Math.round(lat * 1e5) * 1e-5,
    Math.round(lng * 1e5) * 1e-5,
  ]);
}

describe('encodePolyline test helper', () => {
  it('round-trips through decodePolyline (at 1e-5 precision)', () => {
    const pts: Array<[number, number]> = [
      [63.55, 10.22],
      [63.56123, 10.23456],
      [63.5, -10.9],
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(q(pts));
  });
});

describe('concatStepPolylines', () => {
  it('stitches steps, dropping the duplicated boundary point', () => {
    const leg = legOfSteps(
      [
        [63.5, 10.2],
        [63.51, 10.21],
      ],
      [
        [63.51, 10.21], // duplicate of previous step's last point
        [63.52, 10.22],
        [63.53, 10.23],
      ],
    );
    expect(concatStepPolylines([leg])).toEqual(
      q([
        [63.5, 10.2],
        [63.51, 10.21],
        [63.52, 10.22],
        [63.53, 10.23],
      ]),
    );
  });

  it('spans ALL legs (waypoint routes split into one leg per segment)', () => {
    const legA = legOfSteps([
      [63.5, 10.2],
      [63.51, 10.21],
    ]);
    const legB = legOfSteps([
      [63.51, 10.21],
      [63.52, 10.22],
    ]);
    expect(concatStepPolylines([legA, legB])).toEqual(
      q([
        [63.5, 10.2],
        [63.51, 10.21],
        [63.52, 10.22],
      ]),
    );
  });

  it('skips steps with missing or empty polylines', () => {
    const leg = {
      steps: [
        { polyline: { points: encodePolyline([[63.5, 10.2], [63.51, 10.21]]) } },
        { polyline: { points: '' } },
        {},
        { polyline: { points: encodePolyline([[63.51, 10.21], [63.52, 10.22]]) } },
      ],
    };
    expect(concatStepPolylines([leg])).toEqual(
      q([
        [63.5, 10.2],
        [63.51, 10.21],
        [63.52, 10.22],
      ]),
    );
  });

  it('returns [] when there are no usable steps (caller falls back to overview)', () => {
    expect(concatStepPolylines([])).toEqual([]);
    expect(concatStepPolylines([{}])).toEqual([]);
    expect(concatStepPolylines([{ steps: [] }])).toEqual([]);
  });
});

describe('simplifyPolyline', () => {
  // At lat 63.5 (the screenshot's Norway area): 1e-5 deg lat ≈ 1.11m,
  // 1e-5 deg lng ≈ 0.50m.

  it('always keeps first and last points', () => {
    const pts: Array<[number, number]> = [
      [63.5, 10.2],
      [63.5, 10.25],
      [63.5, 10.3],
    ];
    const out = simplifyPolyline(pts, 1000000);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
    expect(out).toHaveLength(2);
  });

  it('removes collinear intermediate points', () => {
    const pts: Array<[number, number]> = [
      [63.5, 10.2],
      [63.51, 10.2],
      [63.52, 10.2],
      [63.53, 10.2],
    ];
    expect(simplifyPolyline(pts, 1)).toEqual([
      [63.5, 10.2],
      [63.53, 10.2],
    ]);
  });

  it('keeps a deviation larger than the tolerance, drops one smaller', () => {
    // Straight N-S line with a midpoint bumped east.
    const mk = (bumpDegLng: number): Array<[number, number]> => [
      [63.5, 10.2],
      [63.51, 10.2 + bumpDegLng],
      [63.52, 10.2],
    ];
    // ~50m east bump (0.001 deg lng ≈ 50m at lat 63.5) → kept at 25m tol.
    expect(simplifyPolyline(mk(0.001), 25)).toHaveLength(3);
    // ~5m east bump (0.0001 deg lng) → dropped at 25m tol.
    expect(simplifyPolyline(mk(0.0001), 25)).toHaveLength(2);
  });

  it('handles a degenerate segment (identical endpoints) without dropping a real detour', () => {
    // Loop route: start == end, with a far-away middle point.
    const pts: Array<[number, number]> = [
      [63.5, 10.2],
      [64.0, 11.0],
      [63.5, 10.2],
    ];
    const out = simplifyPolyline(pts, 25);
    expect(out).toEqual(pts);
  });

  it('returns short inputs unchanged', () => {
    const two: Array<[number, number]> = [
      [63.5, 10.2],
      [63.6, 10.3],
    ];
    expect(simplifyPolyline(two, 25)).toEqual(two);
    expect(simplifyPolyline([], 25)).toEqual([]);
  });

  it('survives a very long polyline without stack overflow (iterative DP)', () => {
    // 50k points on a wiggly line — recursion-based DP would risk blowing
    // the stack; the iterative version must just work.
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 50000; i++) {
      pts.push([63.5 + i * 0.0001, 10.2 + (i % 2) * 0.00005]);
    }
    const out = simplifyPolyline(pts, POLYLINE_SIMPLIFY_TOLERANCE_M);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.length).toBeLessThan(pts.length);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it('meaningfully compresses a realistic dense road path', () => {
    // Simulated 10km of road at ~10m point spacing with gentle curvature.
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 1000; i++) {
      pts.push([
        63.5 + i * 0.00009,
        10.2 + Math.sin(i / 40) * 0.0005,
      ]);
    }
    const out = simplifyPolyline(pts, POLYLINE_SIMPLIFY_TOLERANCE_M);
    // The curve survives (more than a straight chord)…
    expect(out.length).toBeGreaterThan(2);
    // …but the bulk of the redundant points are gone.
    expect(out.length).toBeLessThan(pts.length / 4);
  });
});
