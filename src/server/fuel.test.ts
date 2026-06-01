/**
 * Unit tests for the adaptive-radius fuel-station lookup (Bug #1 fix).
 *
 * The original silent failure: a single 10 km Places lookup over remote West
 * Texas returned zero results, the function returned "success with null data",
 * and the leg was marked `ready` with no stops and no warning. These tests pin
 * the escalation behavior that replaced it — widen the radius on an empty
 * result, and only declare "exhausted" once every radius has come up empty.
 *
 * No live network: `fetch` is stubbed per-call so we control exactly what each
 * radius lookup returns.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// `server-only` throws under the test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { findTopGasStations } from './fuelPlaces';

const CENTER = { lat: 30, lng: -100 };
const KEY = 'test-key';

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> };

function okResponse(body: unknown): FakeResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function errResponse(status: number, body = ''): FakeResponse {
  return { ok: false, status, text: async () => body };
}

const EMPTY = (): FakeResponse => okResponse({ places: [] });
function station(id: string): FakeResponse {
  return okResponse({
    places: [
      {
        id,
        displayName: { text: `Station ${id}` },
        location: { latitude: 30.01, longitude: -100.01 },
      },
    ],
  });
}

/** Stub global fetch to return `responses[n]` on the nth call; throw if over-called. */
function queueFetch(responses: FakeResponse[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    if (i >= responses.length) throw new Error(`unexpected fetch call #${i + 1}`);
    return responses[i++];
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('findTopGasStations — adaptive radius escalation', () => {
  it('widens to the next radius when the first comes back empty', async () => {
    const fetchMock = queueFetch([EMPTY(), station('a')]);

    const result = await findTopGasStations(CENTER, null, KEY, [10, 25, 100, 500]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).not.toBeNull();
    expect(result.data?.primary.place_id).toBe('a');
    expect(result.exhausted).toBe(false);
    expect(result.callsMade).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves on the first radius without making extra calls', async () => {
    const fetchMock = queueFetch([station('first')]);

    const result = await findTopGasStations(CENTER, null, KEY, [10, 25, 100, 500]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data?.primary.place_id).toBe('first');
    expect(result.exhausted).toBe(false);
    expect(result.callsMade).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports exhausted=true (data null) when every radius is empty', async () => {
    const radii = [10, 25, 100, 500];
    const fetchMock = queueFetch(radii.map(() => EMPTY()));

    const result = await findTopGasStations(CENTER, null, KEY, radii);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toBeNull();
    expect(result.exhausted).toBe(true);
    expect(result.callsMade).toBe(radii.length);
    expect(fetchMock).toHaveBeenCalledTimes(radii.length);
  });

  it('hits the first non-empty radius and stops escalating (radius 3 of 4)', async () => {
    const fetchMock = queueFetch([EMPTY(), EMPTY(), station('c'), station('unused')]);

    const result = await findTopGasStations(CENTER, null, KEY, [10, 25, 100, 500]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data?.primary.place_id).toBe('c');
    expect(result.exhausted).toBe(false);
    expect(result.callsMade).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 4th queued response untouched
  });

  it('short-circuits on a hard Places error without widening the radius', async () => {
    const fetchMock = queueFetch([errResponse(403, 'PERMISSION_DENIED')]);

    const result = await findTopGasStations(CENTER, null, KEY, [10, 25, 100, 500]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.message).toContain('403');
    expect(result.callsMade).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // a 403 won't be fixed by a bigger circle
  });

  it('defaults to the production escalation ladder when no radii are passed', async () => {
    // Four empties is enough to exhaust the default [10, 25, 100, 500] ladder.
    const fetchMock = queueFetch([EMPTY(), EMPTY(), EMPTY(), EMPTY()]);

    const result = await findTopGasStations(CENTER, null, KEY);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.exhausted).toBe(true);
    expect(result.callsMade).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
