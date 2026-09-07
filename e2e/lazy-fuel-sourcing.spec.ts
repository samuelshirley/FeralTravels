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
