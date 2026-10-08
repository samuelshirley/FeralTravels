/**
 * TripMap against a fake Google Maps: no network and no real Maps. The loader
 * (`@googlemaps/js-api-loader`) is mocked and a minimal `google.maps`
 * namespace records every polyline, marker and info window the component
 * draws, so the assertions are about what ends up on the map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { LegWithDetails, POI, Stop } from '@/types/trip';
import { UnitsProvider } from './UnitsContext';

const loader = vi.hoisted(() => ({
  setOptions: vi.fn(),
  importLibrary: vi.fn(),
}));
vi.mock('@googlemaps/js-api-loader', () => loader);

import TripMap from './TripMap';

// ── Fake google.maps ────────────────────────────────────────────────────────

type Listener = () => void;
type LatLngLiteral = { lat: number; lng: number };

class FakeEvented {
  listeners = new Map<string, Listener[]>();
  addListener(evt: string, fn: Listener) {
    const list = this.listeners.get(evt) ?? [];
    list.push(fn);
    this.listeners.set(evt, list);
    return {
      remove: () => {
        this.listeners.set(
          evt,
          (this.listeners.get(evt) ?? []).filter((f) => f !== fn)
        );
      },
    };
  }
  trigger(evt: string) {
    for (const fn of this.listeners.get(evt) ?? []) fn();
  }
}

interface PolylineOpts {
  path: LatLngLiteral[];
  map: FakeMap | null;
  strokeColor?: string;
  strokeWeight?: number;
  zIndex?: number;
  icons?: unknown[];
}
interface MarkerOpts {
  position: LatLngLiteral;
  map: FakeMap | null;
  title?: string;
  zIndex?: number;
  label?: { text: string };
}

const drawn = {
  maps: [] as FakeMap[],
  polylines: [] as FakePolyline[],
  markers: [] as FakeMarker[],
  infoWindows: [] as FakeInfoWindow[],
};

class FakeMap extends FakeEvented {
  fitBounds = vi.fn();
  panTo = vi.fn();
  setZoom = vi.fn();
  constructor(public el: HTMLElement, public opts: Record<string, unknown>) {
    super();
    drawn.maps.push(this);
  }
  getProjection() {
    return undefined; // tiles "still loading" → every stop is its own marker
  }
  getZoom() {
    return 5;
  }
}

class FakePolyline extends FakeEvented {
  map: FakeMap | null;
  constructor(public opts: PolylineOpts) {
    super();
    this.map = opts.map;
    drawn.polylines.push(this);
  }
  setMap(m: FakeMap | null) {
    this.map = m;
  }
}

class FakeMarker extends FakeEvented {
  map: FakeMap | null;
  constructor(public opts: MarkerOpts) {
    super();
    this.map = opts.map;
    drawn.markers.push(this);
  }
  setMap(m: FakeMap | null) {
    this.map = m;
  }
}

class FakeInfoWindow {
  content = '';
  opened = false;
  constructor() {
    drawn.infoWindows.push(this);
  }
  setContent(c: string) {
    this.content = c;
  }
  open() {
    this.opened = true;
  }
  close() {
    this.opened = false;
  }
}

class FakeLatLngBounds {
  pts: LatLngLiteral[] = [];
  extend(p: LatLngLiteral) {
    this.pts.push(p);
    return this;
  }
  getNorthEast() {
    return { equals: () => false };
  }
  getSouthWest() {
    return {};
  }
}

const fakeGoogle = {
  maps: {
    Polyline: FakePolyline,
    Marker: FakeMarker,
    InfoWindow: FakeInfoWindow,
    LatLngBounds: FakeLatLngBounds,
    LatLng: class {
      constructor(public lat: number, public lng: number) {}
    },
    Point: class {
      constructor(public x: number, public y: number) {}
    },
    SymbolPath: { CIRCLE: 0 },
  },
};

const live = <T extends { map: FakeMap | null }>(items: T[]) => items.filter((i) => i.map !== null);

// ── Fixtures ────────────────────────────────────────────────────────────────

function stop(id: string, extra: Partial<Stop> = {}): Stop {
  return {
    id,
    leg_id: 'leg-1',
    sort_order: 1,
    stop_type: 'fuel',
    status: 'selected',
    name: `Station ${id}`,
    lat: 41.0,
    lng: -4.0,
    distance_from_start_km: 100,
    notes: null,
    fuel_type: 'diesel',
    fuel_amount_l: null,
    source: 'google_places',
    source_url: null,
    alternatives: null,
    place_id: null,
    google_maps_uri: null,
    forced_reason: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...extra,
  };
}

function leg(id: string, extra: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id,
    trip_id: 'trip-1',
    sort_order: 1,
    leg_type: 'drive',
    title: 'Madrid → Burgos',
    label: 'DAY 1',
    segment_index: null,
    segment_name: null,
    start_name: 'Madrid',
    end_name: 'Burgos',
    start_lat: 40.4,
    start_lng: -3.7,
    end_lat: 42.3,
    end_lng: -3.7,
    dates: null,
    date_iso: '2099-06-01',
    distance_km: 500,
    drive_time_minutes: 300,
    terrain: null,
    overnight: null,
    status: 'planned',
    color: '#123456',
    notes: null,
    fuel_status: 'ready',
    fuel_plan_error: null,
    fuel_stops_updated_at: null,
    continuity_warning: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [-3.7, 40.4],
        [-3.8, 41.3],
        [-3.7, 42.3],
      ],
    },
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    range_remaining_start_km: null,
    costs: [],
    links: [],
    routes: [],
    stops: [],
    tasks: [],
    parsedNotes: [],
    ...extra,
  };
}

const POIS: POI[] = [
  {
    id: 'poi-1',
    leg_id: null,
    source: 'osm',
    external_id: null,
    name: 'Viewpoint',
    lat: 41.5,
    lng: -3.9,
    type: null,
    description: null,
    rating: null,
    url: null,
    data: null,
    last_verified: null,
    status: 'active',
  },
];

// ── Harness ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

interface RenderOpts {
  legs?: LegWithDetails[];
  pois?: POI[];
  units?: 'metric' | 'imperial';
  onLegSelect?: (id: string) => void;
  onStopSelect?: (legId: string, stopId: string) => void;
}

function renderMap(opts: RenderOpts = {}) {
  return render(
    <UnitsProvider initialUnits={opts.units ?? 'metric'}>
      <TripMap
        tripId="trip-1"
        legs={opts.legs ?? [leg('leg-1')]}
        pois={opts.pois ?? []}
        selectedLegId={null}
        onLegSelect={opts.onLegSelect ?? vi.fn()}
        onStopSelect={opts.onStopSelect}
      />
    </UnitsProvider>
  );
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId('trip-map')).toHaveAttribute('data-map-ready', 'true'));
}

beforeEach(() => {
  drawn.maps = [];
  drawn.polylines = [];
  drawn.markers = [];
  drawn.infoWindows = [];
  loader.importLibrary.mockReset();
  loader.importLibrary.mockImplementation(async () => ({ Map: FakeMap }));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/me') return json({ units_pref: 'metric', timezone: 'UTC' });
    if (url === '/api/me/preferences') return json({ ok: true });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('google', fakeGoogle);
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-maps-key');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TripMap — loading Google Maps', () => {
  it('configures the loader with the one public key and loads the maps library', async () => {
    renderMap();
    await ready();
    expect(loader.setOptions).toHaveBeenCalledWith({ key: 'test-maps-key', v: 'weekly' });
    expect(loader.importLibrary).toHaveBeenCalledWith('maps');
    expect(drawn.maps).toHaveLength(1);
    // The map is mounted into the component's own container.
    expect(screen.getByTestId('trip-map')).toContainElement(drawn.maps[0].el);
  });

  it('shows a loading line until the library resolves', async () => {
    let resolve: (v: { Map: typeof FakeMap }) => void = () => {};
    loader.importLibrary.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderMap();
    expect(screen.getByText('Loading Google Maps…')).toBeInTheDocument();
    expect(screen.getByTestId('trip-map')).toHaveAttribute('data-map-ready', 'false');
    await act(async () => resolve({ Map: FakeMap }));
    await ready();
    expect(screen.queryByText('Loading Google Maps…')).not.toBeInTheDocument();
  });

  it('a load failure is shown on the map, not swallowed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    loader.importLibrary.mockRejectedValue(new Error('RefererNotAllowedMapError'));
    renderMap();
    expect(await screen.findByText(/Map failed to load\./)).toBeInTheDocument();
    expect(screen.getByText(/RefererNotAllowedMapError/)).toBeInTheDocument();
    expect(screen.queryByText('Loading Google Maps…')).not.toBeInTheDocument();
    expect(screen.getByTestId('trip-map')).toHaveAttribute('data-map-ready', 'false');
    consoleError.mockRestore();
  });

  it('a missing key is shown, and nothing is loaded', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', '');
    renderMap();
    expect(await screen.findByText(/Map failed to load\./)).toBeInTheDocument();
    expect(screen.getByText(/NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set/)).toBeInTheDocument();
    expect(loader.importLibrary).not.toHaveBeenCalled();
  });
});

describe('TripMap — drawing the trip from props', () => {
  it("draws each leg's stored route geometry, converted from [lng, lat]", async () => {
    renderMap({ legs: [leg('leg-1')] });
    await ready();
    await waitFor(() => expect(live(drawn.polylines).length).toBeGreaterThan(0));
    const route = live(drawn.polylines).find((p) => p.opts.strokeColor === '#123456');
    expect(route?.opts.path).toEqual([
      { lat: 40.4, lng: -3.7 },
      { lat: 41.3, lng: -3.8 },
      { lat: 42.3, lng: -3.7 },
    ]);
    expect(drawn.maps[0].fitBounds).toHaveBeenCalled();
  });

  it('a leg with no stored geometry falls back to a dashed straight line', async () => {
    renderMap({ legs: [leg('leg-1', { geometry: null })] });
    await ready();
    await waitFor(() => expect(live(drawn.polylines)).toHaveLength(1));
    const line = live(drawn.polylines)[0];
    expect(line.opts.path).toEqual([
      { lat: 40.4, lng: -3.7 },
      { lat: 42.3, lng: -3.7 },
    ]);
    expect(line.opts.icons).toBeDefined();
  });

  it('draws a start marker per leg, a final destination marker and the POIs', async () => {
    renderMap({
      legs: [leg('leg-1'), leg('leg-2', { start_lat: 42.3, start_lng: -3.7, end_lat: 43.3, end_lng: -8.4 })],
      pois: POIS,
    });
    await ready();
    await waitFor(() => expect(live(drawn.markers)).toHaveLength(4));
    const positions = live(drawn.markers).map((m) => m.opts.position);
    expect(positions).toEqual(
      expect.arrayContaining([
        { lat: 40.4, lng: -3.7 }, // leg-1 start
        { lat: 42.3, lng: -3.7 }, // leg-2 start
        { lat: 43.3, lng: -8.4 }, // final destination
        { lat: 41.5, lng: -3.9 }, // POI
      ])
    );
  });

  it('draws a dashed gap line where consecutive legs do not meet', async () => {
    renderMap({
      legs: [leg('leg-1'), leg('leg-2', { start_lat: 45.0, start_lng: 2.0, end_lat: 46.0, end_lng: 2.0, geometry: null })],
    });
    await ready();
    await waitFor(() =>
      expect(live(drawn.polylines).some((p) => p.opts.strokeColor === '#E8705C')).toBe(true)
    );
  });

  it("clicking a leg's route selects that leg", async () => {
    const onLegSelect = vi.fn();
    renderMap({ onLegSelect });
    await ready();
    await waitFor(() => expect(live(drawn.polylines).length).toBeGreaterThan(0));
    live(drawn.polylines)[0].trigger('click');
    expect(onLegSelect).toHaveBeenCalledWith('leg-1');
  });

  it('draws a marker per loaded, non-dismissed stop; clicking one opens it in the list', async () => {
    const onStopSelect = vi.fn();
    renderMap({
      legs: [
        leg('leg-1', {
          stops: [
            stop('s1', { name: 'Repsol Burgos' }),
            stop('s2', { status: 'dismissed', name: 'Old BP' }),
            stop('s3', { lat: null, lng: null, name: 'No coords' }),
          ],
        }),
      ],
      onStopSelect,
    });
    await ready();
    await waitFor(() =>
      expect(live(drawn.markers).filter((m) => m.opts.title)).toHaveLength(1)
    );
    const stopMarker = live(drawn.markers).find((m) => m.opts.title === 'Repsol Burgos');
    expect(stopMarker).toBeDefined();
    stopMarker?.trigger('click');
    expect(onStopSelect).toHaveBeenCalledWith('leg-1', 's1');
    expect(screen.queryByText('Open a day to load its fuel stops')).not.toBeInTheDocument();
  });

  it('with no stops loaded yet, says how to load them', async () => {
    renderMap();
    await ready();
    expect(screen.getByText('Open a day to load its fuel stops')).toBeInTheDocument();
  });
});

describe('TripMap — units in the info windows', () => {
  it('metric: the leg info window gives the distance in km', async () => {
    renderMap({ units: 'metric' });
    await ready();
    await waitFor(() => expect(live(drawn.markers).length).toBeGreaterThan(0));
    const startMarker = live(drawn.markers).find((m) => m.opts.position.lat === 40.4);
    startMarker?.trigger('click');
    expect(drawn.infoWindows[0].content).toContain('500 km');
  });

  it('imperial: the leg info window gives miles and no km', async () => {
    renderMap({ units: 'imperial' });
    await ready();
    await waitFor(() => expect(live(drawn.markers).length).toBeGreaterThan(0));
    const startMarker = live(drawn.markers).find((m) => m.opts.position.lat === 40.4);
    startMarker?.trigger('click');
    expect(drawn.infoWindows[0].content).toContain('311 mi');
    expect(drawn.infoWindows[0].content).not.toMatch(/\bkm\b/);
  });

  it('imperial: the stop hover tooltip gives miles from start and no km', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({
        matches: q === '(hover: hover)',
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
    );
    renderMap({
      units: 'imperial',
      legs: [leg('leg-1', { stops: [stop('s1', { name: 'Repsol', distance_from_start_km: 161 })] })],
    });
    await ready();
    await waitFor(() => expect(live(drawn.markers).some((m) => m.opts.title === 'Repsol')).toBe(true));
    live(drawn.markers).find((m) => m.opts.title === 'Repsol')?.trigger('mouseover');
    const tooltip = drawn.infoWindows[1].content;
    expect(tooltip).toContain('100 mi from start');
    expect(tooltip).not.toMatch(/\bkm\b/);
  });

  /*
   * Was a hardcoded "Nordkapp / 71.17°N — The Goal" (a leftover from the
   * one-trip prototype), so every trip's last pin claimed to be Nordkapp.
   */
  it("the destination marker's info window names the trip's actual destination", async () => {
    renderMap({ legs: [leg('leg-1', { end_name: 'Burgos' })] });
    await ready();
    await waitFor(() => expect(live(drawn.markers).length).toBeGreaterThan(0));
    const finalMarker = live(drawn.markers).find((m) => m.opts.zIndex === 30);
    finalMarker?.trigger('click');
    expect(drawn.infoWindows[0].content).toContain('Burgos');
    expect(drawn.infoWindows[0].content).not.toContain('Nordkapp');
  });

  it('falls back to the last leg title, escaped, when the destination has no name', async () => {
    renderMap({ legs: [leg('leg-1', { end_name: null, title: 'Lyon → <Annecy>' })] });
    await ready();
    await waitFor(() => expect(live(drawn.markers).length).toBeGreaterThan(0));
    live(drawn.markers).find((m) => m.opts.zIndex === 30)?.trigger('click');
    expect(drawn.infoWindows[0].content).toContain('Lyon → &lt;Annecy&gt;');
  });
});
