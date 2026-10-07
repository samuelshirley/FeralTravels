/**
 * Settings → Vehicles. List, add, edit, set default, delete (behind a
 * confirm). The range is stored in km and shown/entered in the user's unit —
 * an imperial user sees and types miles and never sees "km".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VehicleProfileSection, { type Vehicle } from './VehicleProfileSection';
import { UnitsProvider } from './UnitsContext';
import { invalidateVehicleCache } from '@/lib/vehicleCache';
import type { UnitsPref } from '@/lib/units';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function vehicle(id: string, name: string, extra: Partial<Vehicle> = {}): Vehicle {
  return {
    id,
    user_id: 'u1',
    name,
    is_default: false,
    range_km: 500,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...extra,
  };
}

type Call = { url: string; method: string; body: unknown };
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let list: Vehicle[];
let mutationResponse: (call: Call) => Promise<Response>;

function mutations(): Call[] {
  return fetchMock.mock.calls
    .map(([input, init]) => ({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }))
    .filter((c) => c.url.startsWith('/api/vehicles') && c.method !== 'GET');
}

function vehicleGets(): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input) === '/api/vehicles' && (init?.method ?? 'GET') === 'GET'
  ).length;
}

function renderSection(units: UnitsPref = 'metric') {
  return render(
    <UnitsProvider initialUnits={units}>
      <VehicleProfileSection />
    </UnitsProvider>
  );
}

beforeEach(() => {
  invalidateVehicleCache();
  list = [vehicle('v1', 'Hilux', { is_default: true }), vehicle('v2', 'Sprinter', { range_km: 800 })];
  mutationResponse = async () => json({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/me') return json({ units_pref: 'metric', timezone: 'UTC' });
    if (url === '/api/me/preferences') return json({ ok: true });
    if (url === '/api/vehicles' && method === 'GET') return json(list);
    if (url.startsWith('/api/vehicles')) {
      return mutationResponse({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function cards() {
  return screen.findAllByTestId('vehicle-card');
}

describe('VehicleProfileSection — the list', () => {
  it('shows a loading line, then a card per vehicle with its refill distance', async () => {
    renderSection('metric');
    expect(screen.getByText('Loading vehicles…')).toBeInTheDocument();
    const [hilux, sprinter] = await cards();
    expect(within(hilux).getByTestId('vehicle-card-name')).toHaveTextContent('Hilux');
    expect(within(hilux).getByText('Default')).toBeInTheDocument();
    expect(hilux).toHaveTextContent('~500 km');
    expect(sprinter).toHaveTextContent('~800 km');
    expect(within(sprinter).queryByText('Default')).not.toBeInTheDocument();
  });

  it('imperial: the refill distance is in miles and no "km" appears anywhere', async () => {
    const { container } = renderSection('imperial');
    const [hilux, sprinter] = await cards();
    expect(hilux).toHaveTextContent('~311 mi');
    expect(sprinter).toHaveTextContent('~497 mi');
    expect(container.textContent).not.toMatch(/\bkm\b/i);
  });

  it('a sole vehicle explains why it cannot be deleted, and offers no Delete', async () => {
    list = [vehicle('v1', 'Hilux', { is_default: true })];
    renderSection();
    await cards();
    expect(screen.getByTestId('vehicle-solo-reminder')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('a failed load is shown inline', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/api/vehicles' ? json({ error: 'vehicles unavailable' }, 500) : json({})
    );
    renderSection();
    expect(await screen.findByText('vehicles unavailable')).toBeInTheDocument();
  });

  it('a rejected load (offline) is shown inline', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderSection();
    expect(await screen.findByText('Failed to load vehicles.')).toBeInTheDocument();
  });
});

describe('VehicleProfileSection — delete', () => {
  it('asks first; declining sends nothing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderSection();
    const [, sprinter] = await cards();
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Delete' }));
    expect(window.confirm).toHaveBeenCalledWith('Delete this vehicle?');
    expect(mutations()).toEqual([]);
  });

  it('confirmed: DELETE /api/vehicles/:id, then the list is re-read', async () => {
    renderSection();
    const [, sprinter] = await cards();
    const getsBefore = vehicleGets();
    list = [vehicle('v1', 'Hilux', { is_default: true })];
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getAllByTestId('vehicle-card')).toHaveLength(1));
    expect(mutations()).toEqual([{ url: '/api/vehicles/v2', method: 'DELETE', body: undefined }]);
    expect(vehicleGets()).toBe(getsBefore + 1);
  });

  it('a refused delete shows the server message', async () => {
    mutationResponse = async () => json({ error: 'This vehicle is used by a trip' }, 409);
    renderSection();
    const [, sprinter] = await cards();
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This vehicle is used by a trip')).toBeInTheDocument();
    expect(screen.getAllByTestId('vehicle-card')).toHaveLength(2);
  });

  it('an offline delete shows a fallback message', async () => {
    mutationResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderSection();
    const [, sprinter] = await cards();
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete failed.')).toBeInTheDocument();
  });
});

describe('VehicleProfileSection — set default', () => {
  it('PATCHes is_default and re-reads the list', async () => {
    renderSection();
    const [, sprinter] = await cards();
    list = [vehicle('v1', 'Hilux'), vehicle('v2', 'Sprinter', { is_default: true, range_km: 800 })];
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Set default' }));

    await waitFor(() =>
      expect(within(screen.getAllByTestId('vehicle-card')[1]).getByText('Default')).toBeInTheDocument()
    );
    expect(mutations()).toEqual([{ url: '/api/vehicles/v2', method: 'PATCH', body: { is_default: true } }]);
  });

  it('a failure is shown inline', async () => {
    mutationResponse = async () => json({ error: 'Could not change default' }, 500);
    renderSection();
    const [, sprinter] = await cards();
    fireEvent.click(within(sprinter).getByRole('button', { name: 'Set default' }));
    expect(await screen.findByText('Could not change default')).toBeInTheDocument();
  });
});

describe('VehicleProfileSection — add and edit', () => {
  it('adds a vehicle: POST /api/vehicles with the name and range in km', async () => {
    renderSection('metric');
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    expect(form).toHaveTextContent('in kilometers');
    fireEvent.change(within(form).getByTestId('vehicle-name-input'), { target: { value: 'Land Cruiser' } });
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '650' } });
    list = [...list, vehicle('v3', 'Land Cruiser', { range_km: 650 })];
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    await waitFor(() => expect(screen.getAllByTestId('vehicle-card')).toHaveLength(3));
    expect(mutations()).toEqual([
      { url: '/api/vehicles', method: 'POST', body: { name: 'Land Cruiser', range_km: 650 } },
    ]);
    expect(screen.queryByTestId('vehicle-form')).not.toBeInTheDocument();
  });

  it('imperial: the form asks in miles, and the miles typed are saved as km', async () => {
    const { container } = renderSection('imperial');
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    expect(form).toHaveTextContent('in miles');
    expect(container.textContent).not.toMatch(/\bkm\b|kilomet/i);
    fireEvent.change(within(form).getByTestId('vehicle-name-input'), { target: { value: 'Van' } });
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '300' } });
    expect(within(form).getByTestId('vehicle-refill-input')).toHaveValue(300);
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual({ url: '/api/vehicles', method: 'POST', body: { name: 'Van', range_km: 483 } });
  });

  it('the default checkbox is sent when ticked', async () => {
    renderSection();
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    fireEvent.change(within(form).getByTestId('vehicle-name-input'), { target: { value: 'Van' } });
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '400' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Use as my default vehicle' }));
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0].body).toEqual({ name: 'Van', range_km: 400, is_default: true });
  });

  it('an invalid draft is refused locally with a message and no request', async () => {
    renderSection();
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '400' } });
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    expect(await screen.findByText('name is required')).toBeInTheDocument();
    expect(mutations()).toEqual([]);
    expect(screen.getByTestId('vehicle-form')).toBeInTheDocument();
  });

  it('a failed save keeps the form open and shows the server message', async () => {
    mutationResponse = async () => json({ error: 'Name already taken' }, 409);
    renderSection();
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    fireEvent.change(within(form).getByTestId('vehicle-name-input'), { target: { value: 'Hilux' } });
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '400' } });
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    expect(await screen.findByText('Name already taken')).toBeInTheDocument();
    expect(screen.getByTestId('vehicle-form')).toBeInTheDocument();
    expect(within(screen.getByTestId('vehicle-form')).getByTestId('vehicle-save-button')).toBeEnabled();
  });

  it('an offline save shows a fallback message', async () => {
    mutationResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderSection();
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    const form = screen.getByTestId('vehicle-form');
    fireEvent.change(within(form).getByTestId('vehicle-name-input'), { target: { value: 'Van' } });
    fireEvent.change(within(form).getByTestId('vehicle-refill-input'), { target: { value: '400' } });
    fireEvent.click(within(form).getByTestId('vehicle-save-button'));

    expect(await screen.findByText('Save failed.')).toBeInTheDocument();
  });

  it('edits a vehicle in place: PATCH /api/vehicles/:id with the changed draft', async () => {
    renderSection();
    const [hilux] = await cards();
    fireEvent.click(within(hilux).getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByTestId('vehicle-name-input');
    expect(nameInput).toHaveValue('Hilux');
    expect(screen.getByTestId('vehicle-refill-input')).toHaveValue(500);
    fireEvent.change(nameInput, { target: { value: 'Hilux 2' } });
    list = [vehicle('v1', 'Hilux 2', { is_default: true }), list[1]];
    fireEvent.click(screen.getByTestId('vehicle-save-button'));

    await waitFor(() => expect(screen.getAllByTestId('vehicle-card')[0]).toHaveTextContent('Hilux 2'));
    expect(mutations()).toEqual([
      { url: '/api/vehicles/v1', method: 'PATCH', body: { name: 'Hilux 2', range_km: 500, is_default: true } },
    ]);
  });

  it('Cancel leaves the form without a request', async () => {
    renderSection();
    await cards();
    fireEvent.click(screen.getByTestId('add-vehicle-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('vehicle-form')).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });
});
