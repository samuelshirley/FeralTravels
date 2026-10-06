/**
 * The header chip naming the trip's vehicle. Display only: it reads
 * GET /api/vehicles (through the shared cache) and renders nothing until the
 * trip's vehicle is in that list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import TripVehicleChip from './TripVehicleChip';
import type { Vehicle } from './VehicleProfileSection';
import { invalidateVehicleCache } from '@/lib/vehicleCache';
import { registerGlobalErrorReporter } from '@/lib/api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function vehicle(id: string, name: string): Vehicle {
  return {
    id,
    user_id: 'u1',
    name,
    is_default: false,
    range_km: 600,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

const VEHICLES = [vehicle('v1', 'Hilux'), vehicle('v2', 'Sprinter')];
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  invalidateVehicleCache();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json(VEHICLES));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  registerGlobalErrorReporter(null);
  vi.unstubAllGlobals();
});

describe('TripVehicleChip', () => {
  it("names the trip's vehicle once the list arrives", async () => {
    render(<TripVehicleChip tripId="t1" initialVehicleId="v2" />);
    expect(await screen.findByText('Sprinter')).toBeInTheDocument();
    expect(screen.getByTitle('Trip vehicle: Sprinter')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/vehicles');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('renders nothing when the trip has no vehicle', async () => {
    const { container } = render(<TripVehicleChip tripId="t1" initialVehicleId={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the trip's vehicle is not in the list", async () => {
    const { container } = render(<TripVehicleChip tripId="t1" initialVehicleId="gone" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('follows a changed vehicle id from the parent', async () => {
    const { rerender } = render(<TripVehicleChip tripId="t1" initialVehicleId="v1" />);
    expect(await screen.findByText('Hilux')).toBeInTheDocument();
    rerender(<TripVehicleChip tripId="t1" initialVehicleId="v2" />);
    expect(await screen.findByText('Sprinter')).toBeInTheDocument();
    expect(screen.queryByText('Hilux')).not.toBeInTheDocument();
  });

  it('a failed vehicle load is reported to the global ErrorNotifier, and the chip stays empty', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    fetchMock.mockResolvedValue(json({ error: 'vehicles unavailable' }, 500));
    const { container } = render(<TripVehicleChip tripId="t1" initialVehicleId="v1" />);

    await waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    expect(reporter.mock.calls[0][1]).toMatchObject({ path: '/api/vehicles', status: 500 });
    expect(container).toBeEmptyDOMElement();
  });

  it('a rejected fetch (offline) is reported too', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<TripVehicleChip tripId="t1" initialVehicleId="v1" />);

    await waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    expect(reporter.mock.calls[0][1]).toMatchObject({ path: '/api/vehicles', status: null });
  });
});
