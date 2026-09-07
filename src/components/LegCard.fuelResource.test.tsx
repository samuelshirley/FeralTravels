/**
 * An invalidated day re-sources its fuel — the STRUCTURAL guard for the bug
 * where changing a leg's destination through Penny silently emptied its fuel
 * stops (2026-09-04, Girona → Annecy).
 *
 * The delete was deliberate: `update_leg` with changed coords calls
 * `invalidateLegFuelCache`, which drops the auto stops and resets the leg to
 * `fuel_status: 'none'` with no timestamp. The re-source was what went
 * missing, and it went missing on the CLIENT: LegCard deduped its lazy fetch
 * on `${id}:${status}:${updated_at}`, and an invalidated leg has exactly the
 * signature the first auto-source of that day recorded — `none:none`. So the
 * refetch was swallowed, the open day read "No stops yet" with no spinner,
 * and collapsing / re-expanding could not change the signature either.
 *
 * This drives that sequence through the DOM and asserts on the REQUEST: a leg
 * that was sourced, then invalidated back to `none`, fires a second search.
 * Mutation-checked by restoring the signature guard — the second call never
 * happens and the last assertion goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { LegWithDetails } from '@/types/trip';

vi.mock('next/navigation', () => ({
  usePathname: () => '/trips/00000000-0000-0000-0000-000000000001',
}));

const api = vi.hoisted(() => ({
  planFuelStops: vi.fn<(legId: string) => Promise<unknown>>(),
}));
vi.mock('@/lib/api', () => ({
  tripApi: () => ({
    planFuelStops: api.planFuelStops,
    listStopsForLeg: vi.fn().mockResolvedValue([]),
    updateLeg: vi.fn().mockResolvedValue({}),
  }),
  ApiError: class ApiError extends Error {},
}));

vi.mock('./StopsSection', () => ({ default: () => null }));
vi.mock('@/components/DeviceLocationContext', () => ({
  useDeviceLocation: () => ({
    position: null,
    place: null,
    placeResolved: false,
    gpsStatus: 'unavailable',
    request: vi.fn(),
    enablePath: 'none',
  }),
}));

import LegCard from './LegCard';

afterEach(() => {
  cleanup();
  api.planFuelStops.mockReset();
});

function leg(overrides: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    id: '00000000-0000-0000-0000-0000000000b0',
    trip_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 0,
    leg_type: 'drive',
    title: 'Girona → Annecy',
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: 'Girona',
    end_name: 'Annecy',
    start_lat: 41.9794,
    start_lng: 2.8214,
    end_lat: 45.8992,
    end_lng: 6.1294,
    dates: null,
    date_iso: '2026-09-15',
    distance_km: 652,
    drive_time_minutes: 384,
    terrain: null,
    overnight: null,
    status: 'planning',
    color: null,
    notes: null,
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

const props = {
  tripId: '00000000-0000-0000-0000-000000000001',
  expanded: true,
  onToggle: () => {},
  onNavigate: () => {},
};

const flush = () => act(async () => {});

describe('LegCard re-sources an invalidated day', () => {
  it('fires a second search when a sourced leg is reset to none', async () => {
    api.planFuelStops.mockResolvedValue({});
    const first = leg();
    const view = render(<LegCard {...props} leg={first} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(1);

    // The search landed: the reload brings the leg back `ready`, stamped.
    view.rerender(
      <LegCard
        {...props}
        leg={leg({ fuel_status: 'ready', fuel_stops_updated_at: new Date().toISOString() })}
      />,
    );
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(1);

    // Penny moved the destination: invalidateLegFuelCache reset the leg to
    // `none` with no timestamp — byte-for-byte the state the first search
    // was keyed on. The day is open; it must search again, now.
    view.rerender(<LegCard {...props} leg={leg({ end_name: 'Meythet', end_lat: 45.8619 })} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(2);
  });

  it('does not fire twice while one search is still in flight', async () => {
    let resolve: (v: unknown) => void = () => {};
    api.planFuelStops.mockReturnValue(new Promise((r) => (resolve = r)));
    const view = render(<LegCard {...props} leg={leg()} />);
    await flush();
    // An unrelated trip reload re-renders the card with the same fuel state.
    view.rerender(<LegCard {...props} leg={leg({ notes: 'reloaded' })} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(1);
    resolve({});
    await flush();
  });

  it('retries a failed leg once per open, not on every reload', async () => {
    api.planFuelStops.mockResolvedValue({});
    const view = render(<LegCard {...props} leg={leg({ fuel_status: 'failed' })} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(1);
    view.rerender(<LegCard {...props} leg={leg({ fuel_status: 'failed', notes: 'reloaded' })} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(1);
    // Collapse and open again: the driver asked again.
    view.rerender(<LegCard {...props} expanded={false} leg={leg({ fuel_status: 'failed' })} />);
    await flush();
    view.rerender(<LegCard {...props} expanded leg={leg({ fuel_status: 'failed' })} />);
    await flush();
    expect(api.planFuelStops).toHaveBeenCalledTimes(2);
  });
});
