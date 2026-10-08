/**
 * useStopActions — the stop mutations behind a day card (select, dismiss,
 * delete, swap), driven through the REAL tripApi/apiFetch with a mocked fetch
 * so the method, URL and body on the wire are what is asserted.
 *
 * The contract: an optimistic update, the mutation, then a re-read of the
 * leg's stops. A 404 (an auto replan rewrote the stop's id) is absorbed and
 * re-read; any other failure is THROWN to the caller, which owns the inline
 * error (the mutations opt out of the global notifier to avoid a double
 * report). The re-read itself does not opt out, so its failure reaches the
 * global ErrorNotifier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useStopActions } from './useStopActions';
import { ApiError, registerGlobalErrorReporter } from '@/lib/api';
import type { Stop } from '@/types/trip';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stop(id: string, extra: Partial<Stop> = {}): Stop {
  return {
    id,
    leg_id: 'leg-1',
    sort_order: 1,
    stop_type: 'fuel',
    status: 'option',
    name: `Station ${id}`,
    lat: 42.3,
    lng: -3.7,
    distance_from_start_km: 60,
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

type Call = { url: string; method: string; body: unknown };
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let serverStops: Stop[];
let mutationResponse: () => Promise<Response>;
let listResponse: () => Promise<Response>;

function calls(): Call[] {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  }));
}
const mutationCalls = () => calls().filter((c) => c.method !== 'GET');
const listCalls = () => calls().filter((c) => c.method === 'GET');

beforeEach(() => {
  serverStops = [stop('s1'), stop('s2')];
  mutationResponse = async () => json({ ok: true });
  listResponse = async () => json(serverStops);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_input, init) =>
    (init?.method ?? 'GET') === 'GET' ? listResponse() : mutationResponse()
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  registerGlobalErrorReporter(null);
  vi.unstubAllGlobals();
});

function setup(onChanged = vi.fn()) {
  const hook = renderHook(() =>
    useStopActions({ tripId: 'trip-1', legId: 'leg-1', initialStops: [stop('s1'), stop('s2')], onChanged })
  );
  return { ...hook, onChanged };
}

describe('useStopActions — initial state', () => {
  it('starts from the stops it was given, split into active and dismissed', () => {
    const { result } = renderHook(() =>
      useStopActions({
        tripId: 'trip-1',
        legId: 'leg-1',
        initialStops: [stop('s1'), stop('s2', { status: 'dismissed' })],
      })
    );
    expect(result.current.stops.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(result.current.activeStops.map((s) => s.id)).toEqual(['s1']);
    expect(result.current.dismissedStops.map((s) => s.id)).toEqual(['s2']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('syncInitialStops replaces the list (parent refreshed)', () => {
    const { result } = setup();
    act(() => result.current.syncInitialStops([stop('s9')]));
    expect(result.current.stops.map((s) => s.id)).toEqual(['s9']);
  });
});

describe('useStopActions — the mutations on the wire', () => {
  it('select: POST /api/stops/:id/select, then re-reads the leg and notifies', async () => {
    serverStops = [stop('s1', { status: 'selected' }), stop('s2')];
    const { result, onChanged } = setup();
    await act(() => result.current.select('s1'));

    expect(mutationCalls()).toEqual([{ url: '/api/stops/s1/select', method: 'POST', body: {} }]);
    expect(listCalls()).toEqual([
      { url: '/api/stops?tripId=trip-1&legId=leg-1', method: 'GET', body: undefined },
    ]);
    expect(result.current.stops.find((s) => s.id === 's1')?.status).toBe('selected');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('select is optimistic: the stop reads selected before the server answers', async () => {
    let release: (r: Response) => void = () => {};
    mutationResponse = () => new Promise<Response>((r) => (release = r));
    const { result } = setup();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.select('s2');
    });
    expect(result.current.stops.find((s) => s.id === 's2')?.status).toBe('selected');
    await act(async () => {
      release(json({ ok: true }));
      await pending;
    });
  });

  it('dismiss: PATCH /api/stops/:id with status dismissed, and the stop moves to dismissedStops', async () => {
    serverStops = [stop('s1', { status: 'dismissed' }), stop('s2')];
    const { result } = setup();
    await act(() => result.current.dismiss('s1'));

    expect(mutationCalls()).toEqual([
      { url: '/api/stops/s1', method: 'PATCH', body: { tripId: 'trip-1', status: 'dismissed' } },
    ]);
    expect(result.current.dismissedStops.map((s) => s.id)).toEqual(['s1']);
    expect(result.current.activeStops.map((s) => s.id)).toEqual(['s2']);
  });

  it('swapAlternate: POST /api/stops/:id/swap-primary with the alternate index', async () => {
    const { result } = setup();
    await act(() => result.current.swapAlternate('s1', 1));
    expect(mutationCalls()).toEqual([
      { url: '/api/stops/s1/swap-primary', method: 'POST', body: { alt_index: 1 } },
    ]);
    expect(listCalls()).toHaveLength(1);
  });
});

describe('useStopActions — delete keeps its confirmation', () => {
  it('declining the confirm sends nothing', async () => {
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmSpy);
    const { result } = setup();
    await act(() => result.current.remove('s1'));
    expect(confirmSpy).toHaveBeenCalledWith('Delete this stop?');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirmed: DELETE /api/stops/:id?tripId=…, then re-read', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    serverStops = [stop('s2')];
    const { result } = setup();
    await act(() => result.current.remove('s1'));
    expect(mutationCalls()).toEqual([{ url: '/api/stops/s1?tripId=trip-1', method: 'DELETE', body: undefined }]);
    expect(result.current.stops.map((s) => s.id)).toEqual(['s2']);
  });
});

describe('useStopActions — failures', () => {
  it('a 404 (stop replaced by an auto replan) is absorbed and the leg re-read', async () => {
    mutationResponse = async () => json({ error: 'Stop not found' }, 404);
    serverStops = [stop('s7')];
    const { result } = setup();
    await act(() => result.current.select('s1'));
    expect(result.current.stops.map((s) => s.id)).toEqual(['s7']);
  });

  it('any other failure is thrown to the caller (and still re-reads the truth)', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    mutationResponse = async () => json({ error: 'database unavailable' }, 500);
    const { result } = setup();

    let caught: unknown = null;
    await act(async () => {
      await result.current.dismiss('s1').catch((e: unknown) => {
        caught = e;
      });
    });
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(500);
    expect((caught as ApiError).message).toBe('database unavailable');
    // Rolled back to the server's list rather than left optimistic.
    expect(result.current.stops.find((s) => s.id === 's1')?.status).toBe('option');
    // The mutation opted out of the global notifier — the caller owns that error.
    expect(reporter).not.toHaveBeenCalled();
  });

  it('a rejected fetch (offline) is thrown to the caller', async () => {
    mutationResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { result } = setup();
    await expect(
      act(async () => {
        await result.current.swapAlternate('s1', 0);
      })
    ).rejects.toThrow('Failed to fetch');
  });

  it('a failed re-read reaches the global ErrorNotifier', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    listResponse = async () => json({ error: 'stops unavailable' }, 503);
    const { result, onChanged } = setup();
    await act(() => result.current.reload());

    await waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    expect(reporter.mock.calls[0][1]).toMatchObject({ path: '/api/stops', status: 503 });
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.stops.map((s) => s.id)).toEqual(['s1', 's2']);
  });
});
