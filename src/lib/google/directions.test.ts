import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  buildDirectionsParams,
  concatStepPolylines,
  decodePolyline,
  directionsPointParam,
  getDirections,
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


/**
 * Routing BY PLACE ID, and why one line of query-string building is worth this
 * much test.
 *
 * MEASURED 2026-09-10 against the live key, Guadalupe Mountains NP → Zion NP.
 * These are the record; do NOT turn them into a test that calls Google — that
 * would put a paid third-party request in the unit suite and go red the day a
 * centroid moves:
 *
 *   destination=37.2982022,-113.0263005                → ZERO_RESULTS
 *   destination=place_id:ChIJ2fhEiNDqyoAR9VY2qhU6Lnw    → OK 1335.1 km / 774 min
 *   destination="Zion National Park" (text)             → OK 1329.0 km / 767 min
 *
 * And the snapped point that comes back out of the place_id call routes on its
 * own, in both directions, where the centroid we asked with does not:
 *
 *   Guadalupe → 37.2336032,-112.8751275   OK 1335.1 km / 12.9 h
 *   37.2336032,-112.8751275 → Austin      OK 1916.0 km / 18.7 h
 *
 * Big Bend's centroid happens to land near a park road. That is the whole
 * reason half of one trip planned and half of it did not.
 */
describe('place_id in the query string', () => {
  const KEY = 'test-key';
  const ZION = 'ChIJ2fhEiNDqyoAR9VY2qhU6Lnw';

  it('sends place_id: when there is one, and the coordinate when there is not', () => {
    expect(directionsPointParam({ lat: 1.5, lng: 2.5 })).toBe('1.5,2.5');
    expect(directionsPointParam({ lat: 1.5, lng: 2.5, place_id: ZION })).toBe(`place_id:${ZION}`);
    // Null and empty are "no id", not an id. An empty `place_id:` is a request
    // Google rejects outright.
    expect(directionsPointParam({ lat: 1.5, lng: 2.5, place_id: null })).toBe('1.5,2.5');
    expect(directionsPointParam({ lat: 1.5, lng: 2.5, place_id: '' })).toBe('1.5,2.5');
  });

  it('carries origin and destination INDEPENDENTLY', () => {
    // The real case is exactly this asymmetry: a town origin that routes fine
    // and a national-park destination that does not.
    const params = buildDirectionsParams(
      { lat: 31.9, lng: -104.8 },
      { lat: 37.2982022, lng: -113.0263005, place_id: ZION },
      {},
      KEY,
    );
    expect(params.get('origin')).toBe('31.9,-104.8');
    expect(params.get('destination')).toBe(`place_id:${ZION}`);

    const flipped = buildDirectionsParams(
      { lat: 31.9, lng: -104.8, place_id: 'ChIJ_origin' },
      { lat: 37.3, lng: -113.0 },
      {},
      KEY,
    );
    expect(flipped.get('origin')).toBe('place_id:ChIJ_origin');
    expect(flipped.get('destination')).toBe('37.3,-113');
  });

  it('carries it on waypoints too, mixed with plain coordinates', () => {
    // `place_id:` is legal in the pipe-separated waypoints list, and a park
    // driven THROUGH has the same unreachable-centroid problem as one driven TO.
    const params = buildDirectionsParams(
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      {
        waypoints: [
          { lat: 1.5, lng: 1.5 },
          { lat: 1.7, lng: 1.7, place_id: 'ChIJ_wp' },
        ],
      },
      KEY,
    );
    expect(params.get('waypoints')).toBe('1.5,1.5|place_id:ChIJ_wp');
  });

  it('still builds everything else the same way', () => {
    const params = buildDirectionsParams(
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { avoid: ['tolls', 'ferries'], departureTime: 1_700_000_000 },
      KEY,
    );
    expect(params.get('mode')).toBe('driving');
    expect(params.get('key')).toBe(KEY);
    expect(params.get('avoid')).toContain('tolls');
    expect(params.get('departure_time')).toBe('1700000000');
  });
});

/** A minimal OK Directions body, with the snapped points Google really sends. */
function directionsBody(opts: {
  startLocation?: { lat: number; lng: number };
  endLocation?: { lat: number; lng: number };
} = {}) {
  return {
    status: 'OK',
    routes: [
      {
        warnings: [],
        legs: [
          {
            distance: { value: 1_000_000 },
            duration: { value: 36_000 },
            start_address: 'A',
            end_address: 'B',
            start_location: opts.startLocation ?? { lat: 10, lng: 20 },
            end_location: opts.endLocation ?? { lat: 30, lng: 40 },
            steps: [],
          },
        ],
        overview_polyline: { points: '' },
      },
    ],
  };
}

describe('the cache tells a place_id request from a bare-coordinate one', () => {
  const ZION = 'ChIJ2fhEiNDqyoAR9VY2qhU6Lnw';

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is two entries and two fetches, not one shared answer', async () => {
    /*
     * THE BUG THIS PREVENTS. The same coordinate asked WITH an id and WITHOUT
     * one are different requests with different answers — one routes, one is
     * ZERO_RESULTS — so a key that ignored the id would serve whichever was
     * asked first to both. Which one that is depends on the order Penny happens
     * to call in, i.e. it would fail intermittently and look like Google.
     */
    const fetchMock = vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify(directionsBody()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Coordinates unique to this test — the LRU is module-level and lives for
    // the whole file.
    const origin = { lat: 31.91, lng: -104.81 };
    const dest = { lat: 37.291, lng: -113.021 };

    const bare = await getDirections(origin, dest);
    const byId = await getDirections(origin, { ...dest, place_id: ZION });
    const bareAgain = await getDirections(origin, dest);

    expect(bare.ok && byId.ok && bareAgain.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The third call is the FIRST one's cache entry, not the second's.
    expect(bareAgain.ok && bareAgain.cached).toBe(true);
    expect(byId.ok && byId.cached).toBe(false);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('destination=37.291%2C-113.021');
    expect(urls[1]).toContain(`destination=place_id%3A${ZION}`);
  });

  it('harvests the snapped start and end out of the response', async () => {
    // Free — they are in a response we already paid for — and they are the
    // coordinates worth persisting, because a leg row carries no place_id and
    // every later re-route starts again from what we stored.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            directionsBody({
              startLocation: { lat: 31.8911, lng: -104.8093 },
              endLocation: { lat: 37.2336032, lng: -112.8751275 },
            }),
          ),
          { status: 200 },
        ),
      ),
    );

    const res = await getDirections(
      { lat: 31.92, lng: -104.82 },
      { lat: 37.292, lng: -113.022, place_id: ZION },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // NOT the coordinates we asked with — that is the entire point.
    expect(res.end_location).toEqual({ lat: 37.2336032, lng: -112.8751275 });
    expect(res.start_location).toEqual({ lat: 31.8911, lng: -104.8093 });
  });

  it('falls back to what we asked with when Google omits the field', async () => {
    // Leaves the caller exactly where it stood before this existed, rather
    // than handing it a null to branch on.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = directionsBody();
        delete (body.routes[0].legs[0] as Record<string, unknown>).end_location;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    const res = await getDirections({ lat: 41.1, lng: -71.1 }, { lat: 42.2, lng: -72.2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.end_location).toEqual({ lat: 42.2, lng: -72.2 });
  });

  it('reads the LAST leg for the end, not the first, when there are waypoints', async () => {
    // With waypoints Google returns one leg per segment. Reading legs[0] for
    // both would report the first hop's end as the whole route's — the same
    // class of bug the distance sum already had.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: 'OK',
            routes: [
              {
                warnings: [],
                legs: [
                  {
                    distance: { value: 1000 },
                    duration: { value: 60 },
                    start_address: 'A',
                    end_address: 'WP',
                    start_location: { lat: 1.11, lng: 1.11 },
                    end_location: { lat: 2.22, lng: 2.22 },
                    steps: [],
                  },
                  {
                    distance: { value: 2000 },
                    duration: { value: 120 },
                    start_address: 'WP',
                    end_address: 'B',
                    start_location: { lat: 2.22, lng: 2.22 },
                    end_location: { lat: 3.33, lng: 3.33 },
                    steps: [],
                  },
                ],
                overview_polyline: { points: '' },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const res = await getDirections(
      { lat: 51.1, lng: -1.1 },
      { lat: 52.2, lng: -2.2 },
      { waypoints: [{ lat: 51.5, lng: -1.5 }] },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.start_location).toEqual({ lat: 1.11, lng: 1.11 });
    expect(res.end_location).toEqual({ lat: 3.33, lng: 3.33 });
  });
});
