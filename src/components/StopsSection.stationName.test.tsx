/**
 * The web stop card's station name, on a tap (Sam, 2026-11-11).
 *
 * A fuel row reads "Fuel stop · 89 km" — Google's terms forbid storing the
 * station's name. Its info control fetches the name by place id and shows it
 * in place of "Fuel stop"; a failure keeps the label and says why underneath.
 * The row itself stays the Google Maps link; the control is a sibling.
 * The iOS card shares `loadStationName` and is held to the same wiring at
 * source level (stationNameGuard.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Stop } from '@/types/trip';

vi.mock('next/navigation', () => ({ usePathname: () => '/trips/t1' }));
vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/api', () => ({
  apiFetch: api.fetch,
  // The stop actions hook's client; nothing here removes or selects a stop.
  tripApi: () => ({}),
  ApiError: class ApiError extends Error {},
}));

import StopsSection from './StopsSection';

afterEach(() => {
  cleanup();
  api.fetch.mockReset();
});

function fuelStop(over: Partial<Stop> = {}): Stop {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    leg_id: 'leg-1',
    sort_order: 0,
    stop_type: 'fuel',
    status: 'option',
    name: 'Fuel stop',
    lat: 37.885,
    lng: -1.36,
    distance_from_start_km: 89,
    notes: null,
    fuel_type: null,
    fuel_amount_l: null,
    source: 'google',
    source_url: null,
    alternatives: null,
    place_id: 'ChIJN-4JNefXWw0RoSJmAD56BX4',
    google_maps_uri: null,
    forced_reason: null,
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
    ...over,
  } as Stop;
}

function renderCard(stop: Stop) {
  render(
    <StopsSection
      tripId="t1"
      legId="leg-1"
      legStartName="Intermediate stop"
      legEndName="Cúllar, Spain"
      initialStops={[stop]}
      fuelStatus="ready"
    />,
  );
}

describe('a fuel stop’s station name (web)', () => {
  it('a tap fetches the name and shows it in place of "Fuel stop"; the row is still the Maps link', async () => {
    api.fetch.mockResolvedValue({ name: 'Repsol Librilla A-7' });
    renderCard(fuelStop());
    expect(screen.getByText('Fuel stop · 89 km')).toBeTruthy();
    expect(api.fetch).not.toHaveBeenCalled(); // nothing is fetched until asked

    fireEvent.click(screen.getByTestId('fuel-stop-name'));

    await screen.findByText('Repsol Librilla A-7 · 89 km');
    expect(api.fetch).toHaveBeenCalledWith('/api/stops/00000000-0000-4000-8000-0000000000f1/place-name', {
      skipGlobalErrorReport: true,
    });
    expect(screen.queryByText('Fuel stop · 89 km')).toBeNull();
    expect(screen.queryByTestId('fuel-stop-name')).toBeNull();
    const link = screen.getByRole('link', { name: /in Google Maps/ });
    expect(link.getAttribute('href')).toContain('destination_place_id=ChIJN-4JNefXWw0RoSJmAD56BX4');
  });

  it('a failure keeps "Fuel stop · 89 km" and says why — never a blank', async () => {
    api.fetch.mockRejectedValue(Object.assign(new Error('502'), { payload: { code: 'station_name_unavailable' } }));
    renderCard(fuelStop());

    fireEvent.click(screen.getByTestId('fuel-stop-name'));

    await waitFor(() => expect(screen.getByTestId('fuel-stop-name-error').textContent).toBe("Couldn't load the station name."));
    expect(screen.getByText('Fuel stop · 89 km')).toBeTruthy();
    expect(screen.getByTestId('fuel-stop-name')).toBeTruthy(); // can try again
  });

  it('a fuel stop without a place id offers no name control', () => {
    renderCard(fuelStop({ place_id: null }));
    expect(screen.queryByTestId('fuel-stop-name')).toBeNull();
  });
});
