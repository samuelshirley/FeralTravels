import { describe, expect, it } from 'vitest';
import {
  buildNavUrl,
  buildSegmentedNavUrls,
  buildLegDirectionsUrl,
  legDirectionsWaypoints,
  type LegDirectionsStopInput,
  type NavSegment,
} from './maps';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stop factory — only fills the fields LegDirectionsStopInput needs. */
function makeStop(
  overrides: Partial<LegDirectionsStopInput> & { lat: number; lng: number; name: string }
): LegDirectionsStopInput {
  return {
    status: 'option',
    stop_type: 'fuel',
    source: 'penny',
    distance_from_start_km: null,
    sort_order: null,
    ...overrides,
  };
}

const PARIS = { lat: 48.8566, lng: 2.3522 };
const STRASBOURG = { lat: 48.5734, lng: 7.7521 };
const NANCY = { lat: 48.6921, lng: 6.1844 };
const METZ = { lat: 49.1193, lng: 6.1757 };

const LEG_COORDS = {
  start_lat: PARIS.lat,
  start_lng: PARIS.lng,
  end_lat: STRASBOURG.lat,
  end_lng: STRASBOURG.lng,
};

// ---------------------------------------------------------------------------
// buildNavUrl
// ---------------------------------------------------------------------------

describe('buildNavUrl', () => {
  it('returns null when destination coords are missing', () => {
    expect(buildNavUrl({ end_lat: null, end_lng: null })).toBeNull();
  });

  it('builds a URL with dir_action=navigate by default', () => {
    const url = buildNavUrl(LEG_COORDS)!;
    const u = new URL(url);
    expect(u.searchParams.get('dir_action')).toBe('navigate');
    expect(u.searchParams.get('travelmode')).toBe('driving');
    expect(u.searchParams.get('origin')).toBe(`${PARIS.lat},${PARIS.lng}`);
    expect(u.searchParams.get('destination')).toBe(`${STRASBOURG.lat},${STRASBOURG.lng}`);
  });

  it('omits dir_action when navigate is false', () => {
    const url = buildNavUrl(LEG_COORDS, undefined, { navigate: false })!;
    const u = new URL(url);
    expect(u.searchParams.has('dir_action')).toBe(false);
  });

  it('includes waypoints as pipe-delimited coords', () => {
    const url = buildNavUrl(LEG_COORDS, [
      [NANCY.lat, NANCY.lng],
      [METZ.lat, METZ.lng],
    ])!;
    const u = new URL(url);
    expect(u.searchParams.get('waypoints')).toBe(
      `${NANCY.lat},${NANCY.lng}|${METZ.lat},${METZ.lng}`
    );
  });

  it('filters out NaN/Infinity waypoints', () => {
    const url = buildNavUrl(LEG_COORDS, [
      [NaN, 6.0],
      [NANCY.lat, NANCY.lng],
      [Infinity, -Infinity],
    ])!;
    const u = new URL(url);
    expect(u.searchParams.get('waypoints')).toBe(`${NANCY.lat},${NANCY.lng}`);
  });
});

// ---------------------------------------------------------------------------
// legDirectionsWaypoints
// ---------------------------------------------------------------------------

describe('legDirectionsWaypoints', () => {
  it('includes fuel stops regardless of status (except dismissed)', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Fuel Nancy', stop_type: 'fuel', status: 'option' }),
      makeStop({ ...METZ, name: 'Fuel Metz', stop_type: 'fuel', status: 'dismissed' }),
    ];
    const wps = legDirectionsWaypoints(stops);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toEqual([NANCY.lat, NANCY.lng]);
  });

  it('includes non-fuel stops only when status is selected', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Rest Nancy', stop_type: 'rest', status: 'selected' }),
      makeStop({ ...METZ, name: 'Rest Metz', stop_type: 'rest', status: 'option' }),
    ];
    const wps = legDirectionsWaypoints(stops);
    expect(wps).toHaveLength(1);
    expect(wps[0]).toEqual([NANCY.lat, NANCY.lng]);
  });

  it('sorts by distance_from_start_km then sort_order', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...METZ, name: 'Far', distance_from_start_km: 300, sort_order: 1 }),
      makeStop({ ...NANCY, name: 'Near', distance_from_start_km: 200, sort_order: 2 }),
    ];
    const wps = legDirectionsWaypoints(stops);
    expect(wps[0]).toEqual([NANCY.lat, NANCY.lng]); // nearer first
    expect(wps[1]).toEqual([METZ.lat, METZ.lng]);
  });

  it('returns empty array when no stops qualify', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Dismissed', status: 'dismissed' }),
    ];
    expect(legDirectionsWaypoints(stops)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSegmentedNavUrls
// ---------------------------------------------------------------------------

describe('buildSegmentedNavUrls', () => {
  it('returns null when destination coords are missing', () => {
    expect(
      buildSegmentedNavUrls({
        legCoords: { start_lat: PARIS.lat, start_lng: PARIS.lng, end_lat: null, end_lng: null },
      })
    ).toBeNull();
  });

  it('returns a single segment when there are no stops', () => {
    const segments = buildSegmentedNavUrls({
      legCoords: LEG_COORDS,
      endName: 'Strasbourg',
    })!;
    expect(segments).toHaveLength(1);
    // Labels are destination-only (no origin) since URLs use device GPS
    expect(segments[0].label).toBe('Strasbourg');

    const u = new URL(segments[0].url);
    expect(u.searchParams.has('waypoints')).toBe(false);
    expect(u.searchParams.get('dir_action')).toBe('navigate');
    // No origin param — Google Maps uses device GPS
    expect(u.searchParams.has('origin')).toBe(false);
  });

  it('splits into N+1 segments for N intermediate stops', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Nancy fuel', distance_from_start_km: 200 }),
      makeStop({ ...METZ, name: 'Metz fuel', distance_from_start_km: 300 }),
    ];

    const segments = buildSegmentedNavUrls({
      legCoords: LEG_COORDS,
      endName: 'Strasbourg',
      stops,
    })!;

    expect(segments).toHaveLength(3);
    expect(segments[0].label).toBe('Nancy fuel');
    expect(segments[1].label).toBe('Metz fuel');
    expect(segments[2].label).toBe('Strasbourg');

    // Every segment: dir_action=navigate, no waypoints, no origin
    for (const seg of segments) {
      const u = new URL(seg.url);
      expect(u.searchParams.get('dir_action')).toBe('navigate');
      expect(u.searchParams.has('waypoints')).toBe(false);
      expect(u.searchParams.has('origin')).toBe(false);
    }
  });

  it('uses default labels when start/end names are not provided', () => {
    const segments = buildSegmentedNavUrls({ legCoords: LEG_COORDS })!;
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe('Destination');
  });

  it('excludes dismissed stops from segments', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Dismissed', status: 'dismissed', distance_from_start_km: 200 }),
      makeStop({ ...METZ, name: 'Metz fuel', distance_from_start_km: 300 }),
    ];
    const segments = buildSegmentedNavUrls({
      legCoords: LEG_COORDS,
      endName: 'Strasbourg',
      stops,
    })!;
    expect(segments).toHaveLength(2);
    expect(segments[0].label).toBe('Metz fuel');
    expect(segments[1].label).toBe('Strasbourg');
  });

  it('uses selectedRoute end coords when provided', () => {
    const segments = buildSegmentedNavUrls({
      legCoords: LEG_COORDS,
      endName: 'Stuttgart',
      selectedRoute: { end_lat: 48.7758, end_lng: 9.1829 },
    })!;
    expect(segments).toHaveLength(1);
    const u = new URL(segments[0].url);
    expect(u.searchParams.get('destination')).toBe('48.7758,9.1829');
  });

  it('segment destinations have correct coords', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Nancy', distance_from_start_km: 200 }),
    ];
    const segments = buildSegmentedNavUrls({
      legCoords: LEG_COORDS,
      endName: 'Strasbourg',
      stops,
    })!;

    // Segment 1: navigate to Nancy (no origin — uses device GPS)
    const u1 = new URL(segments[0].url);
    expect(u1.searchParams.has('origin')).toBe(false);
    expect(u1.searchParams.get('destination')).toBe(`${NANCY.lat},${NANCY.lng}`);

    // Segment 2: navigate to Strasbourg
    const u2 = new URL(segments[1].url);
    expect(u2.searchParams.has('origin')).toBe(false);
    expect(u2.searchParams.get('destination')).toBe(`${STRASBOURG.lat},${STRASBOURG.lng}`);
  });
});

// ---------------------------------------------------------------------------
// buildLegDirectionsUrl (backward compat — still used as fallback)
// ---------------------------------------------------------------------------

describe('buildLegDirectionsUrl', () => {
  it('returns a URL with waypoints and dir_action=navigate', () => {
    const stops: LegDirectionsStopInput[] = [
      makeStop({ ...NANCY, name: 'Nancy fuel', distance_from_start_km: 200 }),
    ];
    const url = buildLegDirectionsUrl({ legCoords: LEG_COORDS, stops })!;
    const u = new URL(url);
    expect(u.searchParams.get('dir_action')).toBe('navigate');
    expect(u.searchParams.get('waypoints')).toContain(`${NANCY.lat},${NANCY.lng}`);
  });

  it('returns a URL without waypoints when no stops qualify', () => {
    const url = buildLegDirectionsUrl({ legCoords: LEG_COORDS, stops: [] })!;
    const u = new URL(url);
    expect(u.searchParams.has('waypoints')).toBe(false);
    expect(u.searchParams.get('dir_action')).toBe('navigate');
  });
});
