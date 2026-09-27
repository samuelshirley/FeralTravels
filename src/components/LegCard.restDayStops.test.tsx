/**
 * A stop on a base day (`leg_type: 'rest'`) is on screen, on its day.
 *
 * `getTrip` has always returned a rest leg's stops and both maps have plotted
 * them, but the card's `expanded && isRestDay` branch never rendered
 * StopsSection — so "overnight in Lisbon" was saved and invisible in the list.
 * Unlike `LegCard.restDay.test.tsx`, StopsSection is NOT mocked here: the
 * question is what the driver sees, and a stub would answer it for the wrong
 * reason.
 *
 * The native half has no test runner; `src/lib/restDayStopsGuard.test.ts`
 * covers it from source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LegWithDetails } from '@/types/trip';

vi.mock('next/navigation', () => ({
  usePathname: () => '/trips/00000000-0000-0000-0000-000000000001',
}));

vi.mock('@/lib/api', () => ({
  tripApi: () => ({
    planFuelStops: vi.fn().mockResolvedValue({}),
    listStopsForLeg: vi.fn().mockResolvedValue([]),
    updateLeg: vi.fn().mockResolvedValue({}),
    updateStop: vi.fn().mockResolvedValue({}),
    deleteStop: vi.fn().mockResolvedValue({}),
  }),
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/components/DeviceLocationContext', () => ({
  useDeviceLocation: () => ({
    position: null,
    gpsStatus: 'unavailable',
    request: vi.fn(),
    enablePath: 'none',
  }),
}));

import LegCard from './LegCard';

afterEach(cleanup);

const PORTO = { lat: 41.1579, lng: -8.6291 };
const LISBON = { lat: 38.7223, lng: -9.1393 };

function leg(overrides: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id: '00000000-0000-0000-0000-0000000000c0',
    trip_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 4,
    leg_type: 'rest',
    title: 'Porto',
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: 'Porto',
    end_name: 'Porto',
    start_lat: PORTO.lat,
    start_lng: PORTO.lng,
    end_lat: PORTO.lat,
    end_lng: PORTO.lng,
    dates: null,
    date_iso: '2099-09-13',
    distance_km: null,
    drive_time_minutes: null,
    terrain: null,
    overnight: 'Porto',
    status: 'planning',
    color: null,
    notes: null,
    // A rest leg is never sourced. 'none' is its real state, and the one that
    // would print "fuel stops appear here automatically" if the gate leaked.
    fuel_status: 'none',
    fuel_plan_error: null,
    fuel_stops_updated_at: null,
    continuity_warning: null,
    geometry: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    costs: [],
    links: [],
    routes: [],
    tasks: [],
    parsedNotes: [],
    stops: [],
    ...overrides,
  } as unknown as LegWithDetails;
}

/** A place the user added to the base day. */
const LELLO = {
  id: '00000000-0000-0000-0000-0000000000d0',
  leg_id: '00000000-0000-0000-0000-0000000000c0',
  sort_order: 0,
  stop_type: 'other',
  status: 'selected',
  name: 'Livraria Lello',
  lat: 41.1465,
  lng: -8.6149,
  distance_from_start_km: null,
  source: 'penny',
};

function renderLeg(l: LegWithDetails) {
  return render(
    <LegCard
      tripId="00000000-0000-0000-0000-000000000001"
      leg={l}
      expanded
      onToggle={() => {}}
      onNavigate={() => {}}
    />
  );
}

function expectNoFuelCopy() {
  expect(screen.queryByText(/Planning fuel stops/)).toBeNull();
  expect(screen.queryByText(/fuel stops appear here/)).toBeNull();
  expect(screen.queryByText(/No fuel stop needed/)).toBeNull();
  expect(screen.queryByText(/^No stops\.$/)).toBeNull();
}

describe('LegCard: stops on a base day', () => {
  it('shows the stop, with its Maps link and remove control, and no fuel UI', () => {
    renderLeg(leg({ stops: [LELLO] } as unknown as Partial<LegWithDetails>));

    expect(screen.getByText('Livraria Lello')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Livraria Lello in Google Maps/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Remove Livraria Lello/i)).toBeInTheDocument();
    expect(screen.getByText('STOPS')).toBeInTheDocument();
    // LOCATION already names the city; no START/DESTINATION rows repeat it.
    expect(screen.queryByText('START')).toBeNull();
    expect(screen.queryByText('DESTINATION')).toBeNull();
    expectNoFuelCopy();
  });

  it('draws no STOPS section at all when the day has none', () => {
    renderLeg(leg());

    expect(screen.queryByText('STOPS')).toBeNull();
    expectNoFuelCopy();
  });

  it('a drive day still shows its START and DESTINATION rows', () => {
    renderLeg(
      leg({
        leg_type: 'drive',
        title: 'Porto → Lisbon',
        end_name: 'Lisbon',
        end_lat: LISBON.lat,
        end_lng: LISBON.lng,
        distance_km: 313,
        // Sourced and fresh, so the card does not fire its lazy fuel fetch.
        fuel_status: 'ready',
        fuel_stops_updated_at: new Date().toISOString(),
      } as Partial<LegWithDetails>)
    );

    expect(screen.getByText('START')).toBeInTheDocument();
    expect(screen.getByText('DESTINATION')).toBeInTheDocument();
  });
});
