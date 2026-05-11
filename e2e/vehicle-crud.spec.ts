import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { playwrightName } from './fixtures/constants';

/**
 * Vehicle CRUD round-trip on the Settings page. Independent of every
 * other test — uses a unique playwright-prefixed name so cleanup can
 * find and remove it after the suite finishes.
 *
 * What we cover here:
 *   - Add vehicle form opens and submits
 *   - The newly-created vehicle re-renders as a card with the right name
 *   - Reload persists the row (genuine save, not just optimistic UI)
 *
 * What we don't cover (other tests already do, or it'd be redundant):
 *   - Edit / delete flows — the form is the same widget, exercising add
 *     + render gives us the most signal per test minute.
 *   - Refill-distance unit conversion — that's pure logic with no
 *     network round trip; covered better by a unit test if/when added.
 */
test.describe('Vehicle CRUD', () => {
  test('add vehicle persists across reload', async ({ page }) => {
    const vehicleName = playwrightName('Test Van');

    await loginAsFixtureUser(page, { redirectTo: '/settings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // The fixture seed always installs `E2E Fixture Van` on this user,
    // so there's always at least one card visible. We don't depend on
    // its presence — just want to make sure the section rendered.
    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();

    await page.getByTestId('add-vehicle-button').click();
    await expect(page.getByTestId('vehicle-form')).toBeVisible();

    await page.getByTestId('vehicle-name-input').fill(vehicleName);
    await page.getByTestId('vehicle-refill-input').fill('400');
    await page.getByTestId('vehicle-save-button').click();

    // After save the form unmounts and a new VehicleCard appears.
    const card = page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId('vehicle-card-name')).toHaveText(vehicleName);

    // Reload to verify the row was actually persisted in Postgres rather
    // than just rendered optimistically. apiFetch on settings page hits
    // /api/vehicles which reads from Drizzle.
    //
    // We wait for the GET /api/vehicles call to complete in addition to
    // the visibility assertion: the React component renders "Loading
    // vehicles…" until the fetch resolves, and on a freshly-reloaded
    // page the JS bundle + hydration + useEffect chain can take a few
    // seconds in headless mode. Without the response wait the assertion
    // sometimes timed out at 10s on a cold cache.
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith('/api/vehicles') && res.request().method() === 'GET',
        { timeout: 20_000 },
      ),
      page.reload(),
    ]);
    await expect(
      page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`),
    ).toBeVisible({ timeout: 15_000 });
  });
});
