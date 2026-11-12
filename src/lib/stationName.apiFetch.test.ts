import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, registerGlobalErrorReporter } from './api';
import { loadStationName } from './stationName';

/**
 * The station-name lookup through the REAL web `apiFetch` — not a stub of it —
 * because the failure it guards against lives in apiFetch's wiring: a 5xx goes
 * to the global reporter, and the global reporter's answer to a 5xx is the
 * full-screen "silly error" modal over the very card that was about to say
 * "Couldn't load the station name."
 *
 * Reproduced on PR #106's iOS run (2026-11-11): stop-actions.yaml taps the name
 * on a seeded stop whose place id Google does not know; Google answers 400,
 * the route 502, and `fuel-stop-name-error` was never visible under the modal.
 * The iOS apiFetch has the same reporter contract (mobile/lib/api.ts) and its
 * card is held to passing `apiFetch` itself (stationNameGuard.test.ts).
 */
describe('station name over the real apiFetch', () => {
  afterEach(() => {
    registerGlobalErrorReporter(null);
    vi.unstubAllGlobals();
  });

  it.each([502, 500, 503, 429, 404])('a %i stays on the card: no global error surface', async (status) => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Station name unavailable.', code: 'station_name_unavailable' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const state = await loadStationName(apiFetch, 'stop-1');

    expect(state.status).toBe('failed');
    expect(reporter).not.toHaveBeenCalled();
  });

  it('a network failure stays on the card too', async () => {
    const reporter = vi.fn();
    registerGlobalErrorReporter(reporter);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));

    expect((await loadStationName(apiFetch, 'stop-1')).status).toBe('failed');
    expect(reporter).not.toHaveBeenCalled();
  });
});
