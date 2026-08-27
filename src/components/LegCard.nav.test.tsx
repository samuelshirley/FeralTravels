/**
 * Render-level guard: a drive leg the app can navigate at all must ALWAYS offer
 * a button to its destination.
 *
 * Written after a live bug (2026-08-26). "August Portugal Trip", leg 0,
 * Girona → Burgos. The card rendered exactly one button — "Route to Fuel —
 * Estación de Servicio Repsol", a stop the user had never selected, 398 km out —
 * and nothing that would route to Burgos. Fill up, then what?
 *
 * Every existing test passed. The data was perfect: the leg had end coords,
 * `buildSegmentedNavUrls` returned both segments, `maps.test.ts` was green. The
 * loss happened in JSX, in a branch that swapped the list for a single button
 * whenever GPS reported the device near the route — which includes standing at
 * the leg's own start, i.e. at home, weeks before departure.
 *
 * So these assertions are deliberately made through the DOM rather than against
 * a pure function. The invariant is about what the driver can SEE.
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
  }),
  ApiError: class ApiError extends Error {},
}));

// StopsSection has its own suite; this one is about the nav buttons.
vi.mock('./StopsSection', () => ({ default: () => null }));

const gps = vi.hoisted(() => ({
  value: { position: null as { lat: number; lng: number } | null, gpsStatus: 'unavailable' as string },
}));
vi.mock('@/components/DeviceLocationContext', () => ({
  useDeviceLocation: () => ({ ...gps.value, request: vi.fn(), enablePath: 'none' }),
}));

import LegCard from './LegCard';

afterEach(() => {
  cleanup();
  gps.value = { position: null, gpsStatus: 'unavailable' };
});

/** The exact leg from the bug report, trimmed to what LegCard reads. */
function gironaToBurgos(overrides: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id: '00000000-0000-0000-0000-0000000000a0',
    trip_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 0,
    leg_type: 'drive',
    title: 'Girona → Burgos',
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: 'Girona',
    end_name: 'Burgos',
    start_lat: 41.9794,
    start_lng: 2.8214,
    end_lat: 42.34386,
    end_lng: -3.6969,
    dates: null,
    date_iso: '2026-09-15',
    distance_km: 612,
    drive_time_minutes: 300,
    terrain: null,
    overnight: 'Burgos area',
    status: 'planning',
    color: null,
    notes: null,
    // 'ready' + a fresh timestamp so the card does not fire its lazy fuel fetch.
    fuel_status: 'ready',
    fuel_plan_error: null,
    fuel_stops_updated_at: new Date().toISOString(),
    continuity_warning: null,
    geometry: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    costs: [],
    links: [],
    routes: [],
    tasks: [],
    constraints: [],
    parsedNotes: [],
    stops: [
      {
        id: '00000000-0000-0000-0000-0000000000b0',
        leg_id: '00000000-0000-0000-0000-0000000000a0',
        sort_order: 0,
        stop_type: 'fuel',
        // 'option', not 'selected' — the user never picked this station.
        status: 'option',
        name: 'Estación de Servicio Repsol',
        lat: 41.7616363,
        lng: -1.1494891,
        distance_from_start_km: 398,
        source: 'google_places',
      },
    ],
    ...overrides,
  } as unknown as LegWithDetails;
}

function renderLeg(leg: LegWithDetails) {
  return render(
    <LegCard
      tripId="00000000-0000-0000-0000-000000000001"
      leg={leg}
      expanded
      onToggle={() => {}}
      onNavigate={() => {}}
    />
  );
}

/** Every nav button on screen, as {stopType, text}. */
function navButtons() {
  return screen.queryAllByTestId('nav-stop-link').map((el) => ({
    stopType: el.getAttribute('data-nav-stop-type'),
    isNext: el.getAttribute('data-nav-next') === 'true',
    text: el.textContent ?? '',
    href: el.getAttribute('href') ?? '',
  }));
}

describe('LegCard navigation buttons', () => {
  it('offers a destination button with GPS off', () => {
    renderLeg(gironaToBurgos());
    expect(navButtons().some((b) => b.stopType === 'destination')).toBe(true);
  });

  it('offers a destination button while GPS is still acquiring', () => {
    gps.value = { position: null, gpsStatus: 'pending' };
    renderLeg(gironaToBurgos());
    expect(navButtons().some((b) => b.stopType === 'destination')).toBe(true);
  });

  it('offers a destination button when parked AT the leg start — the reported bug', () => {
    // Girona. Home. Also leg 0's start, which is what made the app think the
    // trip was underway three weeks early.
    gps.value = { position: { lat: 41.9794, lng: 2.8214 }, gpsStatus: 'active' };
    renderLeg(gironaToBurgos());

    const buttons = navButtons();
    // The old code rendered exactly one button here, and it was the fuel stop.
    expect(buttons.length).toBe(2);

    const destination = buttons.find((b) => b.stopType === 'destination');
    expect(destination, 'no "Route to Destination" button — the driver cannot reach Burgos').toBeDefined();
    expect(destination!.text).toContain('Burgos');
    expect(destination!.href).toContain('42.34386%2C-3.6969');
  });

  it('offers a destination button mid-leg, having passed the fuel stop', () => {
    // Parked at the Repsol: the next stop is now Burgos itself.
    gps.value = { position: { lat: 41.7616363, lng: -1.1494891 }, gpsStatus: 'active' };
    renderLeg(gironaToBurgos());

    const buttons = navButtons();
    expect(buttons.some((b) => b.stopType === 'destination')).toBe(true);
    // The unreached destination is promoted, and nothing was dropped to do it.
    expect(buttons[0].stopType).toBe('destination');
    expect(buttons[0].isNext).toBe(true);
    expect(buttons.length).toBe(2);
  });

  it('promotes the next stop without removing anything behind it', () => {
    gps.value = { position: { lat: 41.9794, lng: 2.8214 }, gpsStatus: 'active' };
    renderLeg(gironaToBurgos());

    const buttons = navButtons();
    expect(buttons[0].stopType).toBe('fuel');
    expect(buttons[0].isNext).toBe(true);
    expect(buttons.filter((b) => b.isNext).length).toBe(1);
    expect(buttons.map((b) => b.stopType)).toEqual(['fuel', 'destination']);
  });

  it('navigates a leg with no stops at all', () => {
    gps.value = { position: { lat: 41.9794, lng: 2.8214 }, gpsStatus: 'active' };
    renderLeg(gironaToBurgos({ stops: [] } as Partial<LegWithDetails>));

    const buttons = navButtons();
    expect(buttons.length).toBe(1);
    expect(buttons[0].stopType).toBe('destination');
  });
});
