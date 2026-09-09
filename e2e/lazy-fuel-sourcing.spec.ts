import { test, expect, type Request } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { openTrip } from './fixtures/nav';

/**
 * Lazy fuel has TWO halves, and this spec used to pin only one of them.
 *
 * It was named "opening a day requests fuel; just loading the trip does not"
 * and asserted ZERO requests before a click. That is half the requirement, and
 * asserting it alone froze the other half as a bug: migration 0013 exists so
 * twenty days don't fan out searches nobody looks at — it was never meant to
 * mean the day you are standing in has no fuel until you tap it. With nothing
 * sourced on load, a freshly planned trip showed no stops in the day card,
 * none on the map, and gave `useNextStop` nothing to point at. The App Store
 * screenshot flow works around it explicitly by opening a day first.
 *
 * So the contract is now BOTH halves:
 *   - exactly ONE leg is sourced on load: the day the driver is on
 *   - every other day waits to be opened
 *
 * We assert the trigger, not the stations: whether a given road has a petrol
 * station is not something this suite should depend on.
 */
const FUEL_POST = /\/api\/legs\/([0-9a-f-]{36})\/fuel-stops/;
const isFuelPost = (req: Request) => req.method() === 'POST' && FUEL_POST.test(req.url());
const legIdOf = (url: string) => url.match(FUEL_POST)?.[1] ?? null;

test.describe('Fuel stops load for today, and on demand for every other day', () => {
  test('the current day sources itself; the rest wait to be opened', async ({ page }) => {
    const fuelRequests: string[] = [];
    page.on('request', (req) => { if (isFuelPost(req)) fuelRequests.push(req.url()); });

    await signInAsNewUser(page);
    await openTrip(page);

    const days = page.getByTestId('leg-card');
    await expect(days.first()).toBeVisible({ timeout: 15_000 });

    // The driver's current day sources itself, collapsed, with no interaction.
    await expect
      .poll(() => fuelRequests.length, {
        message: 'the current day should source its own fuel on load',
        timeout: 15_000,
      })
      .toBe(1);

    // ONE, not one per day. This is the half the original spec protected and
    // it still matters more than the other: the canonical fixture has two
    // legs, so a regression to eager fan-out shows up here as 2.
    await page.waitForTimeout(1_000);
    expect(fuelRequests, 'only the current day is sourced on load').toHaveLength(1);

    const autoSourced = legIdOf(fuelRequests[0]);
    expect(autoSourced, 'the auto-sourced request should name a leg').not.toBeNull();

    // A day that was NOT auto-sourced still sources when opened. Picking the
    // last card rather than the first guarantees it is not the one already
    // done, so this cannot pass by re-observing the load-time request.
    const other = days.last();
    const request = page.waitForRequest(
      (req) => isFuelPost(req) && legIdOf(req.url()) !== autoSourced,
      { timeout: 15_000 }
    );
    await other.click();
    await expect(await request).toBeTruthy();
  });
});

/**
 * Opening a LATER day first must not poison its fuel plan.
 *
 * Three 400 km drives against a 500 km range: no single day needs a stop, but
 * the tank does not reset overnight, so day 3 starts 800 km into one tank and
 * genuinely needs one. Finn can only know that if days 1 and 2 have been
 * sourced — and under lazy day-open sourcing they have not been, if the driver
 * opens day 3 first.
 *
 * Before the cascade, the tank walk counted every unopened day's full distance
 * as burned and handed the planner a negative range. On trip `ab824cde`
 * (2026-09-09, prod) that was 2,396 km burned against 500 km, and day 11 told
 * the driver "Next fuel is 44 km ahead — beyond safe range (-1896 km)": a real
 * station, 44 km away, on what was actually a full tank. It was cached as
 * `no_stations_found` for 48 hours.
 *
 * The assertion is about Finn's arithmetic, not about the stations: we assert
 * the earlier days got SOURCED and that the remote-route warning is absent.
 */
test.describe('Opening a later day sources the days it depends on', () => {
  test('day 3 first still plans, and days 1-2 are sourced behind it', async ({ page }) => {
    const fuelPosts: string[] = [];
    page.on('request', (req) => { if (isFuelPost(req)) fuelPosts.push(req.url()); });

    const email = await signInAsNewUser(page, {
      fixture: { legPreset: 'three_long_drives', rangeKm: 500 },
    });
    expect(email).toBeTruthy();
    await openTrip(page);

    const days = page.getByTestId('leg-card');
    await expect(days.first()).toBeVisible({ timeout: 20_000 });
    await expect(days).toHaveCount(3, { timeout: 20_000 });

    // Open the LAST day first — the whole point. Day 1 sources itself on load
    // (it is the current day), so the cascade's real work is day 2.
    await days.last().click();

    // Finn runs OSRM + Overpass per leg, so give the cascade room.
    await expect
      .poll(async () => {
        const res = await page.request.get(new URL(page.url()).pathname.replace('/trips/', '/api/trips/'));
        if (!res.ok()) return null;
        const body = (await res.json()) as { legs?: { sort_order: number; fuel_status: string }[] };
        return (body.legs ?? [])
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((l) => l.fuel_status)
          .join(',');
      }, {
        message: 'every day up to the one opened should reach a terminal fuel status',
        timeout: 120_000,
        intervals: [2_000],
      })
      .toMatch(/^(ready|no_stations_found),(ready|no_stations_found),(ready|no_stations_found)$/);

    // The bug's signature: a day that needed an ordinary stop, reported as
    // remote geography. Neither the warning nor the arithmetic behind it may
    // appear anywhere on the page.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('No fuel stations found');
    expect(body).not.toMatch(/beyond safe range/i);

    // The cascade is SERVER-side, so it makes no HTTP request of its own — and
    // that is the sharpest available proof. The browser posted for day 1 (it
    // sources itself on load) and for the day we clicked; day 2 was never
    // requested by anyone, yet it came back terminal above. Nothing but the
    // cascade could have sourced it.
    const requested = new Set(fuelPosts.map(legIdOf).filter(Boolean));
    expect(requested.size, 'the browser asked for exactly the two days it touched').toBe(2);
  });
});
