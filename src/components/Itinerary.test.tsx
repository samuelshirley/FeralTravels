/**
 * Itinerary — the day list's OWN behaviour: the header line, inline rename,
 * Expand/Collapse every day, the "behind you" fold, the NEXT STOP row, lazy
 * reveal and map-click focus. LegCard is stubbed: it has its own specs, and
 * here it only needs to show which props it was handed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LegWithDetails, Stop, TripWithLegs } from '@/types/trip';

vi.mock('./LegCard', () => ({
  default: function LegCardStub(props: {
    leg: LegWithDetails;
    expanded: boolean;
    isCurrent?: boolean;
    isPast?: boolean;
    autoSourceFuel?: boolean;
    dateLabel?: string;
    onToggle: () => void;
    onNavigate: () => void;
  }) {
    return (
      <div
        data-testid="leg-card"
        data-leg-id={props.leg.id}
        data-expanded={String(props.expanded)}
        data-current={String(!!props.isCurrent)}
        data-past={String(!!props.isPast)}
        data-auto-source={String(!!props.autoSourceFuel)}
      >
        <span>{props.leg.title}</span>
        <span data-testid="date-label">{props.dateLabel}</span>
        <button onClick={props.onToggle}>Toggle {props.leg.title}</button>
        <button onClick={props.onNavigate}>Show {props.leg.title} on map</button>
      </div>
    );
  },
}));

import Itinerary from './Itinerary';
import { UnitsProvider } from './UnitsContext';

// ── Fixtures ────────────────────────────────────────────────────────────────

function stop(id: string, extra: Partial<Stop> = {}): Stop {
  return {
    id,
    leg_id: 'l1',
    sort_order: 1,
    stop_type: 'fuel',
    status: 'selected',
    name: `Station ${id}`,
    lat: 41.0,
    lng: -4.0,
    distance_from_start_km: 161,
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

function leg(id: string, n: number, extra: Partial<LegWithDetails> = {}): LegWithDetails {
  const day = String(n).padStart(2, '0');
  return {
    id,
    trip_id: 't1',
    sort_order: n,
    leg_type: 'drive',
    title: `Day ${n} drive`,
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: null,
    end_name: null,
    start_lat: 40,
    start_lng: -3,
    end_lat: 41,
    end_lng: -3,
    dates: null,
    date_iso: `2099-06-${day}`,
    distance_km: 400,
    drive_time_minutes: 300,
    terrain: null,
    overnight: null,
    status: 'planned',
    color: null,
    notes: null,
    fuel_status: 'ready',
    fuel_plan_error: null,
    fuel_stops_updated_at: null,
    continuity_warning: null,
    geometry: null,
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

function trip(legs: LegWithDetails[], extra: Partial<TripWithLegs> = {}): TripWithLegs {
  return {
    id: 't1',
    name: 'Iberian loop',
    start_date: null,
    end_date: null,
    start_date_parsed: legs[0]?.date_iso ?? '2099-06-01',
    end_date_parsed: legs[legs.length - 1]?.date_iso ?? null,
    start_date_set: true,
    status: 'active',
    trip_status: 'active',
    onboarding_state: 'done',
    prefer_avoid_highways: false,
    daily_drive_hours: null,
    last_known_lat: null,
    last_known_lng: null,
    last_known_place: null,
    position_updated_at: null,
    current_leg_id: null,
    current_lat: null,
    current_lng: null,
    progress_anchor_date: null,
    progress_updated_at: null,
    declared_range_km: null,
    declared_range_leg_id: null,
    declared_range_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    user_id: 'u1',
    vehicle_id: null,
    is_template: false,
    legs,
    ...extra,
  };
}

const TWO_DAYS = () => [
  leg('l1', 1, { stops: [stop('s1', { name: 'Repsol Burgos' })] }),
  leg('l2', 2, { leg_type: 'drive' }),
];

// ── Harness ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let patchResponse: () => Promise<Response>;

interface Opts {
  trip?: TripWithLegs;
  units?: 'metric' | 'imperial';
  readonly?: boolean;
  onChanged?: () => void;
  onLegSelect?: (id: string) => void;
  focusTarget?: { legId: string; stopId: string | null; nonce: number } | null;
}

function ui(opts: Opts) {
  return (
    <UnitsProvider initialUnits={opts.units ?? 'metric'}>
      <Itinerary
        tripId="t1"
        trip={opts.trip ?? trip(TWO_DAYS())}
        onLegSelect={opts.onLegSelect ?? vi.fn()}
        onChanged={opts.onChanged}
        readonly={opts.readonly}
        focusTarget={opts.focusTarget ?? null}
      />
    </UnitsProvider>
  );
}

function renderItinerary(opts: Opts = {}) {
  const r = render(ui(opts));
  return { ...r, rerenderWith: (next: Opts) => r.rerender(ui(next)) };
}

function patches() {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([input, init]) => ({ url: String(input), body: JSON.parse(String(init?.body)) as unknown }));
}

let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  patchResponse = async () => json({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/me') return json({ units_pref: 'metric', timezone: 'UTC' });
    if (url === '/api/me/preferences') return json({ ok: true });
    if (url === '/api/trips/t1' && init?.method === 'PATCH') return patchResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  ioCallback = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {}
    }
  );
  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const cards = () => screen.queryAllByTestId('leg-card');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Itinerary — header', () => {
  it('names the trip and sums it on one line: dates · distance · days · fuel', () => {
    renderItinerary({ units: 'metric' });
    expect(screen.getByRole('heading', { level: 1, name: 'Iberian loop' })).toBeInTheDocument();
    expect(screen.getByText(/~800 km · 2 days · 1 fuel/)).toBeInTheDocument();
    expect(cards()).toHaveLength(2);
  });

  it('imperial: the distances are miles and no "km" appears anywhere', () => {
    const { container } = renderItinerary({ units: 'imperial' });
    expect(screen.getByText(/~497 mi · 2 days · 1 fuel/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Repsol Burgos in Google Maps' })).toHaveTextContent('100 mi');
    expect(container.textContent).not.toMatch(/\bkm\b/);
  });

  it('formats each day label in the user’s date order', () => {
    const { unmount } = renderItinerary({ units: 'metric' });
    expect(screen.getAllByTestId('date-label')[0]).toHaveTextContent('Mon 1 Jun');
    unmount();
    renderItinerary({ units: 'imperial' });
    expect(screen.getAllByTestId('date-label')[0]).toHaveTextContent('Mon Jun 1');
  });

  it('the day the driver is on is current, and is the one whose fuel is sourced unasked', () => {
    renderItinerary();
    const [first, second] = cards();
    expect(first).toHaveAttribute('data-current', 'true');
    expect(first).toHaveAttribute('data-auto-source', 'true');
    expect(second).toHaveAttribute('data-current', 'false');
    expect(second).toHaveAttribute('data-auto-source', 'false');
  });

  it('readonly (demo): says so, and offers neither rename nor NEXT STOP', () => {
    renderItinerary({ readonly: true });
    expect(screen.getByText(/DEMO \(read-only — clone to edit\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename trip' })).not.toBeInTheDocument();
    expect(screen.queryByText('NEXT STOP')).not.toBeInTheDocument();
  });
});

describe('Itinerary — rename', () => {
  function startRename() {
    fireEvent.click(screen.getByRole('button', { name: 'Rename trip' }));
    return screen.getByRole('textbox', { name: 'Trip name' });
  }

  it('saves: PATCH /api/trips/:id with the trimmed name, then asks the parent to refresh', async () => {
    const onChanged = vi.fn();
    renderItinerary({ onChanged });
    const input = startRename();
    expect(input).toHaveValue('Iberian loop');
    fireEvent.change(input, { target: { value: '  Portugal run  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(patches()).toEqual([{ url: '/api/trips/t1', body: { name: 'Portugal run' } }]);
    expect(screen.queryByRole('textbox', { name: 'Trip name' })).not.toBeInTheDocument();
  });

  it('Enter saves and Escape cancels', async () => {
    const onChanged = vi.fn();
    renderItinerary({ onChanged });
    let input = startRename();
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Trip name' })).not.toBeInTheDocument();
    expect(patches()).toEqual([]);

    input = startRename();
    fireEvent.change(input, { target: { value: 'Kept' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patches()).toEqual([{ url: '/api/trips/t1', body: { name: 'Kept' } }]));
  });

  it('an empty name is refused locally', () => {
    renderItinerary();
    fireEvent.change(startRename(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByText('Name cannot be empty')).toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  it('an unchanged name closes the editor without a request', () => {
    renderItinerary();
    startRename();
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.queryByRole('textbox', { name: 'Trip name' })).not.toBeInTheDocument();
    expect(patches()).toEqual([]);
  });

  it('a refused save stays in the editor and shows the server message', async () => {
    patchResponse = async () => json({ error: 'Name is too long' }, 400);
    const onChanged = vi.fn();
    renderItinerary({ onChanged });
    fireEvent.change(startRename(), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByText('Name is too long')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Trip name' })).toHaveValue('New name');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('an offline save is shown too', async () => {
    patchResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderItinerary();
    fireEvent.change(startRename(), { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
  });
});

describe('Itinerary — expand, focus and navigate', () => {
  it('one control expands every day, then collapses them', () => {
    renderItinerary();
    fireEvent.click(screen.getByRole('button', { name: 'Expand every day' }));
    expect(cards().every((c) => c.getAttribute('data-expanded') === 'true')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse every day' }));
    expect(cards().every((c) => c.getAttribute('data-expanded') === 'false')).toBe(true);
  });

  it("a card's own toggle opens just that day", () => {
    renderItinerary();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Day 2 drive' }));
    expect(cards().map((c) => c.getAttribute('data-expanded'))).toEqual(['false', 'true']);
  });

  it("a card's navigate selects its leg", () => {
    const onLegSelect = vi.fn();
    renderItinerary({ onLegSelect });
    fireEvent.click(screen.getByRole('button', { name: 'Show Day 2 drive on map' }));
    expect(onLegSelect).toHaveBeenCalledWith('l2');
  });

  it('a map-click focus target expands that day and scrolls it into view', async () => {
    const { rerenderWith } = renderItinerary();
    rerenderWith({ focusTarget: { legId: 'l2', stopId: null, nonce: 1 } });
    expect(cards()[1]).toHaveAttribute('data-expanded', 'true');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('NEXT STOP links the first fuel stop of the current day as a drive, not a pin', () => {
    renderItinerary({ units: 'metric' });
    const link = screen.getByRole('link', { name: 'Repsol Burgos in Google Maps' });
    expect(link).toHaveTextContent('NEXT STOP');
    expect(link).toHaveTextContent('Repsol Burgos · fuel · 161 km');
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('travelmode=driving');
    expect(href).toContain('dir_action=navigate');
    expect(href).toContain('destination=41');
    expect(href).not.toContain('origin=');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('no fuel stop loaded on the current day → no NEXT STOP row', () => {
    renderItinerary({ trip: trip([leg('l1', 1), leg('l2', 2)]) });
    expect(screen.queryByText('NEXT STOP')).not.toBeInTheDocument();
  });
});

describe('Itinerary — behind you and completed trips', () => {
  it('days before the reported position fold behind a header, opened on demand', () => {
    renderItinerary({ trip: trip(TWO_DAYS(), { current_leg_id: 'l2' }) });
    expect(cards().map((c) => c.getAttribute('data-leg-id'))).toEqual(['l2']);
    expect(cards()[0]).toHaveAttribute('data-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Behind you — 1 earlier day/ }));
    const past = cards().find((c) => c.getAttribute('data-leg-id') === 'l1');
    expect(past).toHaveAttribute('data-past', 'true');
  });

  it('a trip whose last day has passed is COMPLETED, with every day behind the fold', () => {
    const legs = [leg('l1', 1, { date_iso: '2001-06-01' }), leg('l2', 2, { date_iso: '2001-06-02' })];
    renderItinerary({ trip: trip(legs) });
    expect(screen.getByText(/· COMPLETED/)).toBeInTheDocument();
    expect(cards()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /every day/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show past days — 2 days/ }));
    expect(cards()).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Hide past days — 2 days/ })).toBeInTheDocument();
  });
});

describe('Itinerary — lazy reveal', () => {
  it('mounts the first 20 days and reveals the rest when the sentinel scrolls into view', async () => {
    const legs = Array.from({ length: 25 }, (_, i) => leg(`l${i + 1}`, i + 1, { date_iso: `2099-07-${String(i + 1).padStart(2, '0')}` }));
    renderItinerary({ trip: trip(legs) });
    expect(cards()).toHaveLength(20);
    expect(screen.getByText(/Loading 5 more legs…/)).toBeInTheDocument();

    expect(ioCallback).not.toBeNull();
    act(() => ioCallback?.([{ isIntersecting: true }]));
    await waitFor(() => expect(cards()).toHaveLength(25));
    expect(screen.queryByText(/more legs?…/)).not.toBeInTheDocument();
  });

  it('Expand every day also reveals the days behind the lazy window', () => {
    const legs = Array.from({ length: 22 }, (_, i) => leg(`l${i + 1}`, i + 1, { date_iso: `2099-07-${String(i + 1).padStart(2, '0')}` }));
    renderItinerary({ trip: trip(legs) });
    fireEvent.click(screen.getByRole('button', { name: 'Expand every day' }));
    expect(cards()).toHaveLength(22);
    expect(within(cards()[21]).getByText('Day 22 drive')).toBeInTheDocument();
  });
});
