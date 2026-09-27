import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';

/**
 * Sourcing a later day sources the days it depends on — server-side, in one
 * request (decision C4, the dependency cascade).
 *
 * The bug: a never-opened day is indistinguishable from "needed no fuel" to
 * Finn's tank walk. On 2026-09-09 (prod) opening day 11 first walked 2,396 km
 * against a 500 km range and told the driver "Next fuel is 44 km ahead — beyond
 * safe range (-1896 km)" about a real station on what was actually a full tank,
 * and cached it as `no_stations_found` for 48 hours. So before planning day N,
 * `planFuelStopsForLegLazy` sources every unsourced drive day before it.
 *
 * A server contract, so it is asserted without a screen — and more sharply than
 * a screen could: nothing here opens the trip, so nothing sources day 1 or 2 on
 * its own. ONE request is made, for day 3; if days 1 and 2 come back sourced,
 * only the cascade can have done it. (What the DRIVER sees — today sourcing
 * itself, another day on open — is mobile/maestro/trip-itinerary.yaml. This
 * was the second half of e2e/lazy-fuel-sourcing.spec.ts until 2026-09-27.)
 *
 * Three 400 km days in a 500 km range, so every day genuinely needs the tank
 * state of the one before. The assertion is about Finn's arithmetic, not about
 * where Google's stations are: every day must reach `ready`, and none may be
 * written off as remote.
 */
type Leg = { id: string; sort_order: number; fuel_status: string; fuel_plan_error?: string | null };

test.describe('Fuel dependency cascade', () => {
  test('sourcing day 3 first sources days 1 and 2 behind it', async ({ page }) => {
    // Up to three real Places searches inside ONE request.
    test.setTimeout(180_000);

    await signInAsNewUser(page, {
      redirectTo: '/settings',
      fixture: { legPreset: 'three_long_drives', rangeKm: 500 },
    });

    const trips = await page.request.get('/api/trips');
    expect(trips.ok(), await trips.text()).toBe(true);
    const [trip] = (await trips.json()) as Array<{ id: string }>;
    expect(trip, 'the fixture seeded no trip').toBeTruthy();

    const legsOf = async (): Promise<Leg[]> => {
      const res = await page.request.get(`/api/trip?tripId=${trip.id}`);
      expect(res.ok(), await res.text()).toBe(true);
      const body = (await res.json()) as { legs?: Leg[] };
      return (body.legs ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    };

    const before = await legsOf();
    expect(before).toHaveLength(3);
    // Nothing sourced yet — or the cascade would have nothing to prove.
    expect(before.map((l) => l.fuel_status)).toEqual(['none', 'none', 'none']);

    const sourced = await page.request.post(`/api/legs/${before[2].id}/fuel-stops`);
    expect(sourced.ok(), await sourced.text()).toBe(true);

    const after = await legsOf();
    expect(
      after.map((l) => l.fuel_status),
      JSON.stringify(after.map((l) => ({ status: l.fuel_status, error: l.fuel_plan_error ?? null }))),
    ).toEqual(['ready', 'ready', 'ready']);
  });
});
