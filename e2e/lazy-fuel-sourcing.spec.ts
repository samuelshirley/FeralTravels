import { test, expect, type Request } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { openTrip } from './fixtures/nav';

/**
 * Fuel stops are sourced when the user OPENS a day, not when the trip loads
 * (migration 0013 — the whole point is not fanning out searches for days
 * nobody looks at).
 *
 * We assert the trigger, not the stations: whether a given road has a petrol
 * station is not something this suite should depend on.
 */
const FUEL_POST = /\/api\/legs\/[0-9a-f-]{36}\/fuel-stops/;
const isFuelPost = (req: Request) => req.method() === 'POST' && FUEL_POST.test(req.url());

test.describe('Fuel stops load when you open a day', () => {
  test('opening a day requests fuel; just loading the trip does not', async ({ page }) => {
    const fuelRequests: string[] = [];
    page.on('request', (req) => { if (isFuelPost(req)) fuelRequests.push(req.url()); });

    await signInAsNewUser(page);

    await openTrip(page);

    const days = page.getByTestId('leg-card');
    await expect(days.first()).toBeVisible({ timeout: 15_000 });

    // Days are collapsed: nothing should have been sourced yet.
    await page.waitForTimeout(1_000);
    expect(fuelRequests, 'no fuel sourced before a day is opened').toHaveLength(0);

    const request = page.waitForRequest(isFuelPost, { timeout: 15_000 });
    await days.first().click();
    await expect(await request).toBeTruthy();
  });
});
