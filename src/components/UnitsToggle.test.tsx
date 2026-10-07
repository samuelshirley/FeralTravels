/**
 * Settings → Display units. The toggle writes through UnitsContext to
 * PATCH /api/me/preferences, flips optimistically, and on failure rolls back
 * AND says so inline — a toggle that silently snaps back is a swallowed error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UnitsToggle from './UnitsToggle';
import { UnitsProvider } from './UnitsContext';
import type { UnitsPref } from '@/lib/units';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (url: string, init: RequestInit | undefined) => Promise<Response>;
let prefsHandler: Handler;
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function unitsPatches(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url) === '/api/me/preferences' && init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
    .filter((b) => 'units_pref' in b);
}

function renderToggle(initialUnits: UnitsPref = 'metric') {
  return render(
    <UnitsProvider initialUnits={initialUnits}>
      <UnitsToggle />
    </UnitsProvider>
  );
}

beforeEach(() => {
  prefsHandler = async () => json({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    // The provider's one-off timezone sync — answer it so it stays quiet.
    if (url === '/api/me') return json({ units_pref: 'metric', timezone: 'UTC' });
    if (url === '/api/me/preferences') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if ('timezone' in body) return json({ ok: true });
      return prefsHandler(url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UnitsToggle', () => {
  it('renders both options with the stored preference selected', () => {
    renderToggle('imperial');
    expect(screen.getByRole('tablist', { name: 'Display units' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Imperial (mi)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Metric (km)' })).toHaveAttribute('aria-selected', 'false');
  });

  it('picking the other unit PATCHes /api/me/preferences and selects it', async () => {
    renderToggle('metric');
    fireEvent.click(screen.getByRole('tab', { name: 'Imperial (mi)' }));

    await waitFor(() => expect(unitsPatches()).toEqual([{ units_pref: 'imperial' }]));
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/api/me/preferences' && String(init?.body).includes('units_pref')
    );
    expect(call?.[1]?.method).toBe('PATCH');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Imperial (mi)' })).toHaveAttribute('aria-selected', 'true')
    );
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it('clicking the unit that is already selected sends nothing', async () => {
    renderToggle('metric');
    fireEvent.click(screen.getByRole('tab', { name: 'Metric (km)' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(unitsPatches()).toEqual([]);
  });

  it('a non-2xx answer rolls the toggle back and shows the server message', async () => {
    prefsHandler = async () => json({ error: 'Preferences are unavailable right now' }, 500);
    renderToggle('metric');
    fireEvent.click(screen.getByRole('tab', { name: 'Imperial (mi)' }));

    expect(await screen.findByText('Preferences are unavailable right now')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Metric (km)' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a network failure rolls back and shows a fallback message', async () => {
    prefsHandler = async () => {
      throw new TypeError('Failed to fetch');
    };
    renderToggle('metric');
    fireEvent.click(screen.getByRole('tab', { name: 'Imperial (mi)' }));

    expect(await screen.findByText('Failed to update preference.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Metric (km)' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clears the previous error on the next successful pick', async () => {
    prefsHandler = async () => json({ error: 'Nope' }, 500);
    renderToggle('metric');
    fireEvent.click(screen.getByRole('tab', { name: 'Imperial (mi)' }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();

    prefsHandler = async () => json({ ok: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Imperial (mi)' }));
    await waitFor(() => expect(screen.queryByText('Nope')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Imperial (mi)' })).toHaveAttribute('aria-selected', 'true');
  });
});
