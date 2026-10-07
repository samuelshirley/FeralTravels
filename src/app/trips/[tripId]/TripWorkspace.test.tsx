/**
 * TripWorkspace — the workspace's OWN behaviour: which layout it builds per
 * viewport, which panes the paywall locks (map + list, never the chat), that
 * the trip it holds is handed down, and that it refreshes after a change.
 *
 * The heavy children are stubbed (TripMap behind next/dynamic, ChatPanel,
 * Itinerary) so each stub can show the props it received and fire the
 * callbacks the workspace wires up. Viewport and device location are mocked;
 * everything else — AppNavbar, BottomNav, PaneLock, the paywall hook,
 * TripVehicleChip, the real tripApi/apiFetch — runs for real against a
 * mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LegWithDetails, OnboardingState, POI, TripWithLegs } from '@/types/trip';
import type { BlockReason } from '@/types/entitlement';
import { registerGlobalErrorReporter } from '@/lib/api';
import { invalidateVehicleCache } from '@/lib/vehicleCache';

// ── Mocks ───────────────────────────────────────────────────────────────────

const env = vi.hoisted(() => ({
  viewport: 'desktop' as 'mobile' | 'tablet' | 'desktop',
  location: {
    position: null as { lat: number; lng: number } | null,
    place: null as string | null,
    placeResolved: false,
  },
}));

vi.mock('@/lib/useMediaQuery', () => ({ useViewport: () => env.viewport }));
vi.mock('@/lib/useKeyboardOpen', () => ({ useKeyboardOpen: () => false }));
vi.mock('@/components/DeviceLocationContext', () => ({
  DeviceLocationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDeviceLocation: () => env.location,
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/SupportModal', () => ({ default: () => null }));

interface MapStubProps {
  legs: LegWithDetails[];
  pois: POI[];
  selectedLegId: string | null;
  onLegSelect: (id: string) => void;
  onStopSelect?: (legId: string, stopId: string) => void;
}
vi.mock('next/dynamic', () => ({
  default: () =>
    function TripMapStub(props: MapStubProps) {
      return (
        <div
          data-testid="trip-map-stub"
          data-leg-count={props.legs.length}
          data-poi-count={props.pois.length}
          data-selected={props.selectedLegId ?? ''}
        >
          <button onClick={() => props.onStopSelect?.(props.legs[0].id, 's1')}>Map: stop marker</button>
          <button onClick={() => props.onLegSelect(props.legs[0].id)}>Map: leg marker</button>
        </div>
      );
    },
}));

vi.mock('@/components/Itinerary', () => ({
  default: function ItineraryStub(props: {
    trip: TripWithLegs;
    onLegSelect: (id: string) => void;
    onChanged?: () => void;
    isFuelSyncing?: boolean;
    readonly?: boolean;
    focusTarget?: { legId: string; stopId: string | null; nonce: number } | null;
  }) {
    return (
      <div
        data-testid="itinerary-stub"
        data-focus={props.focusTarget ? `${props.focusTarget.legId}:${props.focusTarget.stopId}` : ''}
        data-fuel-syncing={String(!!props.isFuelSyncing)}
        data-readonly={String(!!props.readonly)}
      >
        <h1>{props.trip.name}</h1>
        <span>{props.trip.legs.length} days</span>
        <button onClick={() => props.onChanged?.()}>Itinerary: changed</button>
        <button onClick={() => props.onLegSelect(props.trip.legs[0].id)}>Itinerary: show day on map</button>
      </div>
    );
  },
}));

vi.mock('@/components/ChatPanel', () => ({
  default: function ChatPanelStub(props: {
    tripId: string;
    onboardingState: OnboardingState;
    onTripUpdated?: () => void;
    onActivity?: (evt: 'thinking' | 'response' | 'error' | 'fuel-planning') => void;
  }) {
    return (
      <section aria-label="Chat with Penny" data-onboarding={props.onboardingState}>
        <button onClick={() => props.onTripUpdated?.()}>Chat: Penny changed the trip</button>
        <button onClick={() => props.onActivity?.('response')}>Chat: Penny replied</button>
      </section>
    );
  },
}));

import TripWorkspace from './TripWorkspace';

// ── Fixtures ────────────────────────────────────────────────────────────────

function leg(id: string, n: number, extra: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id,
    trip_id: 't1',
    sort_order: n,
    leg_type: 'drive',
    title: `Day ${n}`,
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
    date_iso: `2099-06-0${n}`,
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

function trip(extra: Partial<TripWithLegs> = {}): TripWithLegs {
  return {
    id: 't1',
    name: 'Iberian loop',
    start_date: null,
    end_date: null,
    start_date_parsed: '2099-06-01',
    end_date_parsed: '2099-06-02',
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
    vehicle_id: 'v1',
    is_template: false,
    legs: [leg('l1', 1), leg('l2', 2)],
    ...extra,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let tripResponse: () => Promise<Response>;

function urls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}
const tripGets = () => urls().filter((u) => u === '/api/trip?tripId=t1').length;
const positionPosts = () =>
  fetchMock.mock.calls
    .filter(([input]) => String(input) === '/api/trips/t1/position')
    .map(([, init]) => ({ method: init?.method, body: JSON.parse(String(init?.body)) as unknown }));

interface Opts {
  initialTrip?: TripWithLegs | null;
  readonly?: boolean;
  blockReason?: BlockReason | null;
  openChatOnMount?: boolean;
}

function renderWorkspace(opts: Opts = {}) {
  const initialTrip = opts.initialTrip === undefined ? trip() : opts.initialTrip;
  return render(
    <TripWorkspace
      tripId="t1"
      serverTrip={{ name: 'Iberian loop', vehicle_id: 'v1' }}
      initialTrip={initialTrip}
      initialPois={[]}
      readonly={opts.readonly ?? false}
      user={{ name: 'Sam', email: 'sam@example.com', image: null }}
      blockReason={opts.blockReason ?? null}
      openChatOnMount={opts.openChatOnMount}
    />
  );
}

/** Let the mount-time refresh settle. */
async function settled() {
  await waitFor(() => expect(tripGets()).toBeGreaterThanOrEqual(1));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  env.viewport = 'desktop';
  env.location = { position: null, place: null, placeResolved: false };
  invalidateVehicleCache();
  tripResponse = async () => json(trip());
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/trip?tripId=t1') return tripResponse();
    if (url === '/api/pois?tripId=t1') return json([]);
    if (url === '/api/vehicles') {
      return json([
        { id: 'v1', user_id: 'u1', name: 'Hilux', is_default: true, range_km: 600, created_at: '', updated_at: '' },
      ]);
    }
    if (url === '/api/trips/t1/position') return json({ ok: true });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  registerGlobalErrorReporter(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const scrims = () => screen.queryAllByTestId('pane-lock-scrim');
const notices = () => screen.queryAllByTestId('trip-pane-lock');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TripWorkspace — desktop', () => {
  it('renders the three panes from the server trip, with no loading flash', () => {
    renderWorkspace();
    expect(document.querySelector('[data-layout="desktop"]')).not.toBeNull();
    expect(screen.queryByText('Loading trip')).not.toBeInTheDocument();
    expect(screen.getByTestId('trip-map-stub')).toHaveAttribute('data-leg-count', '2');
    expect(within(screen.getByTestId('itinerary-stub')).getByRole('heading', { name: 'Iberian loop' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat with Penny' })).toHaveAttribute('data-onboarding', 'done');
    expect(scrims()).toHaveLength(0);
  });

  it('refreshes the trip and POIs on mount and hands the fresh trip down', async () => {
    tripResponse = async () => json(trip({ name: 'Iberian loop (renamed by Penny)' }));
    renderWorkspace();
    expect(
      await within(screen.getByTestId('itinerary-stub')).findByRole('heading', {
        name: 'Iberian loop (renamed by Penny)',
      })
    ).toBeInTheDocument();
    expect(urls()).toEqual(expect.arrayContaining(['/api/trip?tripId=t1', '/api/pois?tripId=t1']));
  });

  it('names the trip vehicle in the header', async () => {
    renderWorkspace();
    expect(await screen.findByTitle('Trip vehicle: Hilux')).toBeInTheDocument();
  });

  it('re-reads the trip when the itinerary reports a change', async () => {
    renderWorkspace();
    await settled();
    const before = tripGets();
    fireEvent.click(screen.getByRole('button', { name: 'Itinerary: changed' }));
    await waitFor(() => expect(tripGets()).toBe(before + 1));
  });

  it('re-reads the trip when Penny changes it from the chat', async () => {
    renderWorkspace();
    await settled();
    const before = tripGets();
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Penny changed the trip' }));
    await waitFor(() => expect(tripGets()).toBe(before + 1));
  });

  it('a map marker click focuses that stop in the list and selects the leg', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Map: stop marker' }));
    expect(screen.getByTestId('itinerary-stub')).toHaveAttribute('data-focus', 'l1:s1');
    expect(screen.getByTestId('trip-map-stub')).toHaveAttribute('data-selected', 'l1');
  });
});

describe('TripWorkspace — the paywall lock', () => {
  it('desktop: the map and list are locked, the notice is drawn once (on the list), the chat is untouched', () => {
    renderWorkspace({ blockReason: 'trial_over' });
    expect(scrims()).toHaveLength(2);
    expect(notices()).toHaveLength(1);
    const itinerary = screen.getByTestId('itinerary-stub');
    // The scrim carrying the notice is the one over the list, not the map.
    const noticeScrim = notices()[0].closest('[data-testid="pane-lock-scrim"]') as HTMLElement;
    expect(noticeScrim.parentElement).toContainElement(itinerary);
    expect(noticeScrim.parentElement).not.toContainElement(screen.getByTestId('trip-map-stub'));
    // The list content sits in an inert wrapper; the chat is outside every lock.
    expect(itinerary.closest('[inert], [aria-hidden="true"]')).not.toBeNull();
    const chat = screen.getByRole('region', { name: 'Chat with Penny' });
    expect(chat.closest('[inert], [aria-hidden="true"]')).toBeNull();
  });

  it("the notice's plan button opens the one purchase sheet", () => {
    renderWorkspace({ blockReason: 'trial_over' });
    fireEvent.click(screen.getByTestId('trip-pane-lock-cta'));
    expect(screen.getAllByRole('dialog', { name: 'Get the app' })).toHaveLength(1);
  });

  it('a capped account gets the support link, not the plan button', () => {
    renderWorkspace({ blockReason: 'usage_cap' });
    expect(screen.getByTestId('trip-pane-lock-support')).toHaveAttribute('href', 'mailto:support@feraltravels.com');
    expect(screen.queryByTestId('trip-pane-lock-cta')).not.toBeInTheDocument();
  });

  it('the readonly demo trip is never locked, and has no vehicle chip', async () => {
    renderWorkspace({ blockReason: 'trial_over', readonly: true });
    expect(scrims()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
    expect(screen.getByTestId('itinerary-stub')).toHaveAttribute('data-readonly', 'true');
    await settled();
    expect(screen.queryByTitle(/Trip vehicle/)).not.toBeInTheDocument();
  });

  it('tablet: the same two panes lock, the notice is drawn once', () => {
    env.viewport = 'tablet';
    renderWorkspace({ blockReason: 'subscription_over' });
    expect(document.querySelector('[data-layout="tablet"]')).not.toBeNull();
    expect(scrims()).toHaveLength(2);
    expect(notices()).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Chat with Penny' }).closest('[inert]')).toBeNull();
  });

  it('mobile: only the tab on screen draws the notice, on the list and on the map', () => {
    env.viewport = 'mobile';
    renderWorkspace({ blockReason: 'trial_over' });
    expect(scrims()).toHaveLength(2);
    expect(notices()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(notices()).toHaveLength(1);
    const mapPaneRoot = screen.getByTestId('trip-map-stub').closest('[inert], [aria-hidden="true"]')
      ?.parentElement as HTMLElement;
    expect(within(mapPaneRoot).getByTestId('trip-pane-lock')).toBeInTheDocument();
    // The chat tab stays one tap away and unlocked.
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.getByRole('region', { name: 'Chat with Penny' }).closest('[inert]')).toBeNull();
  });
});

describe('TripWorkspace — mobile tabs', () => {
  beforeEach(() => {
    env.viewport = 'mobile';
  });

  function paneOf(testIdOrEl: HTMLElement): HTMLElement {
    // The absolutely-positioned tab container (PaneLock root or the chat box).
    let el: HTMLElement | null = testIdOrEl;
    while (el && el.style.position !== 'absolute') el = el.parentElement;
    return el as HTMLElement;
  }

  it('opens on the list tab, with the map and chat tabs hidden', () => {
    renderWorkspace();
    expect(document.querySelector('[data-layout="mobile"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    expect(paneOf(screen.getByTestId('itinerary-stub')).style.display).toBe('block');
    expect(paneOf(screen.getByTestId('trip-map-stub')).style.display).toBe('none');
    // Hidden from the accessibility tree too — `hidden: true` to reach it at all.
    expect(screen.queryByRole('region', { name: 'Chat with Penny' })).not.toBeInTheDocument();
    expect(paneOf(screen.getByRole('region', { name: 'Chat with Penny', hidden: true })).style.display).toBe('none');
  });

  it('switching tabs shows that pane', () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    expect(paneOf(screen.getByTestId('trip-map-stub')).style.display).toBe('block');
    expect(paneOf(screen.getByTestId('itinerary-stub')).style.display).toBe('none');
  });

  it('?chat=1 opens on the chat tab', () => {
    renderWorkspace({ openChatOnMount: true });
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    expect(paneOf(screen.getByRole('region', { name: 'Chat with Penny' })).style.display).toBe('flex');
  });

  it('a brand-new trip with no days opens on the chat tab', async () => {
    tripResponse = async () => json(trip({ legs: [] }));
    renderWorkspace({ initialTrip: trip({ legs: [] }) });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page')
    );
  });

  it('a map stop click jumps to the list tab with that stop focused', () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Map: stop marker' }));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('itinerary-stub')).toHaveAttribute('data-focus', 'l1:s1');
  });

  it("a day's show-on-map jumps to the map tab", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Itinerary: show day on map' }));
    expect(screen.getByRole('button', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('trip-map-stub')).toHaveAttribute('data-selected', 'l1');
  });

  it('a reply that lands while on another tab badges the chat tab, cleared on opening it', () => {
    renderWorkspace();
    // The chat is mounted but hidden on the list tab; Penny's reply still arrives.
    fireEvent.click(screen.getByRole('button', { name: 'Chat: Penny replied', hidden: true }));
    expect(within(screen.getByRole('button', { name: 'Chat' })).getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(within(screen.getByRole('button', { name: 'Chat' })).queryByText('1')).not.toBeInTheDocument();
  });
});

describe('TripWorkspace — loading and failures', () => {
  it('with no server trip: a loading state, then the workspace once /api/trip answers', async () => {
    renderWorkspace({ initialTrip: null });
    expect(screen.getByText('Loading trip')).toBeInTheDocument();
    expect(await screen.findByTestId('itinerary-stub')).toBeInTheDocument();
    expect(screen.queryByText('Loading trip')).not.toBeInTheDocument();
  });

  it('a failed first load says the trip was not found AND reports the failure globally', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    tripResponse = async () => json({ error: 'database unavailable' }, 503);
    renderWorkspace({ initialTrip: null });

    expect(await screen.findByText('Trip not found.')).toBeInTheDocument();
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'database unavailable' }),
      expect.objectContaining({ path: '/api/trip', status: 503 })
    );
    consoleError.mockRestore();
  });

  it('a failed refresh keeps the trip on screen and reports the failure globally', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    tripResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderWorkspace();

    await waitFor(() =>
      expect(reporter).toHaveBeenCalledWith(
        expect.any(TypeError),
        expect.objectContaining({ path: '/api/trip', status: null })
      )
    );
    expect(screen.getByTestId('itinerary-stub')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});

describe('TripWorkspace — position report and fuel polling', () => {
  it('reports the device position once, with the resolved place name', async () => {
    env.location = { position: { lat: 45.76, lng: 4.84 }, place: 'Lyon', placeResolved: true };
    const { rerender } = renderWorkspace();
    await waitFor(() => expect(positionPosts()).toHaveLength(1));
    expect(positionPosts()[0]).toEqual({ method: 'POST', body: { lat: 45.76, lng: 4.84, place_name: 'Lyon' } });

    rerender(
      <TripWorkspace
        tripId="t1"
        serverTrip={{ name: 'Iberian loop', vehicle_id: 'v1' }}
        initialTrip={trip()}
        readonly={false}
        user={{ name: 'Sam', email: 'sam@example.com', image: null }}
      />
    );
    await settled();
    expect(positionPosts()).toHaveLength(1);
  });

  it('waits for the place lookup to settle before reporting', async () => {
    env.location = { position: { lat: 45.76, lng: 4.84 }, place: null, placeResolved: false };
    renderWorkspace();
    await settled();
    expect(positionPosts()).toHaveLength(0);
  });

  it('never reports position from the readonly demo', async () => {
    env.location = { position: { lat: 45.76, lng: 4.84 }, place: 'Lyon', placeResolved: true };
    renderWorkspace({ readonly: true });
    await settled();
    expect(positionPosts()).toHaveLength(0);
  });

  it('while a day is sourcing fuel: shows "Fuel…", tells the list, and polls until it is done', async () => {
    vi.useFakeTimers();
    const computing = trip({ legs: [leg('l1', 1, { fuel_status: 'computing' }), leg('l2', 2)] });
    let polls = 0;
    tripResponse = async () => {
      polls += 1;
      return json(polls >= 2 ? trip() : computing);
    };
    renderWorkspace({ initialTrip: computing });
    expect(screen.getByText('Fuel…')).toBeInTheDocument();
    expect(screen.getByTestId('itinerary-stub')).toHaveAttribute('data-fuel-syncing', 'true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tripGets()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(tripGets()).toBe(2);
    expect(screen.queryByText('Fuel…')).not.toBeInTheDocument();
    expect(screen.getByTestId('itinerary-stub')).toHaveAttribute('data-fuel-syncing', 'false');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(tripGets()).toBe(2);
  });
});
