/**
 * Render-level companion to `src/lib/maps.restDay.test.ts`: what the driver
 * actually sees on a day he spends in one place.
 *
 * The reported leg is the interesting part of the diagnosis. It was titled
 * "Porto (rest day)" and it had no distance and no duration — but it was NOT
 * `leg_type: 'rest'`. A rest-TYPED leg renders no navigation block at all on
 * this card (`expanded && !isRestDay`), so the screenshot could not have been
 * one. `add_leg` defaults `leg_type` to 'drive' while the prompt separately
 * asks Penny for the title "<Place> (rest day)", so a rest day she titles
 * correctly but forgets to type lands as a zero-distance DRIVE leg whose start
 * and end are the same coordinates.
 *
 * That is why the fix keys on the geometry (start ≈ end, nothing driven) rather
 * than on `leg_type`: keying on the type would have missed the exact leg in the
 * bug report.
 *
 * Assertions go through the button TEXT rather than a data attribute, so this
 * file says the same thing regardless of which revision of the nav-button
 * markup it is run against.
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

const PORTO = { lat: 41.1579, lng: -8.6291 };

/** The reported leg: "SUN 13 SEP · Porto (rest day)", after Salamanca → Porto. */
function portoRestDay(overrides: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id: '00000000-0000-0000-0000-0000000000c0',
    trip_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 4,
    // Not 'rest' — see the file header. This is the shape that shipped the bug.
    leg_type: 'drive',
    title: 'Porto (rest day)',
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
    date_iso: '2026-09-13',
    distance_km: null,
    drive_time_minutes: null,
    terrain: null,
    overnight: 'Porto',
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
    stops: [],
    ...overrides,
  } as unknown as LegWithDetails;
}

/** A place the user added to the day — the thing "NAVIGATE (1 STOP)" counted. */
const LELLO = {
  id: '00000000-0000-0000-0000-0000000000d0',
  leg_id: '00000000-0000-0000-0000-0000000000c0',
  sort_order: 0,
  stop_type: 'other',
  status: 'selected',
  name: 'Livraria Lello',
  lat: 41.1465,
  lng: -8.6149,
  distance_from_start_km: 2,
  source: 'penny',
};

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

/**
 * Every nav button on screen, by its visible text.
 *
 * Both test ids, deliberately. The current card has a GPS branch that swaps the
 * list for a single `nav-next-stop` button; querying only the list id let the
 * GPS-active case pass for the wrong reason (nothing matched the selector, not
 * nothing was on screen). Whichever markup this runs against, "no button" here
 * means no button.
 */
function navButtonText(): string[] {
  return [
    ...screen.queryAllByTestId('nav-stop-link'),
    ...screen.queryAllByTestId('nav-next-stop'),
  ].map((el) => el.textContent ?? '');
}

describe('LegCard on a day spent in one place', () => {
  it('offers no navigation at all when the day has no added stops', () => {
    renderLeg(portoRestDay());

    expect(navButtonText()).toEqual([]);
    // The heading goes too: an empty "NAVIGATE (0 STOPS)" label would be the
    // same claim in smaller type.
    expect(screen.queryByText(/NAVIGATE \(/)).toBeNull();
  });

  it('offers no "Route to Destination" even with GPS active at the location', () => {
    // Standing in Porto on the rest day: exactly the situation in which the old
    // button was launched, and did nothing.
    gps.value = { position: PORTO, gpsStatus: 'active' };
    renderLeg(portoRestDay());

    expect(navButtonText().some((t) => t.includes('Route to Destination'))).toBe(false);
  });

  it('still offers the added stop, and nothing else', () => {
    renderLeg(portoRestDay({ stops: [LELLO] } as unknown as Partial<LegWithDetails>));

    const buttons = navButtonText();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('Livraria Lello');
    expect(buttons[0]).not.toContain('Route to Destination');
    expect(screen.getByText('NAVIGATE (1 STOP)')).toBeTruthy();
  });

  it('renders no navigation block for a correctly typed rest leg either', () => {
    // Belt to the geometry fix's braces: the card already suppresses the whole
    // expanded drive section for leg_type 'rest'. Asserted so that a future
    // refactor which unifies the two branches cannot quietly put the button back.
    renderLeg(portoRestDay({ leg_type: 'rest' } as Partial<LegWithDetails>));

    expect(navButtonText()).toEqual([]);
  });
});
