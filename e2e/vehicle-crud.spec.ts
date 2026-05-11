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
 *   - Sole-vehicle delete policy — covered by dedicated tests below.
 *   - Refill-distance unit conversion — that's pure logic with no
 *     network round trip; covered better by a unit test if/when added.
 */
test.describe('Vehicle CRUD', () => {
  test('solo vehicle shows reminder without delete button', async ({ page }) => {
    await loginAsFixtureUser(page, { redirectTo: '/settings' });
    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();

    await expect(page.getByTestId('vehicle-solo-reminder')).toBeVisible();
    await expect(page.getByTestId('vehicle-solo-reminder')).toContainText(
      'You need at least one vehicle. Add another first.',
    );

    await expect(page.getByTestId('vehicle-card').getByTestId('vehicle-delete-button')).toHaveCount(
      0,
    );
  });

  test('delete API rejects removing the sole vehicle', async ({ page }) => {
    await loginAsFixtureUser(page, { redirectTo: '/settings' });

    const result = await page.evaluate(async () => {
      const listRes = await fetch('/api/vehicles');
      if (!listRes.ok)
        return { ok: false, step: 'list', status: listRes.status };
      const list = (await listRes.json()) as { id: number }[];
      if (list.length !== 1)
        return { ok: false, step: 'count', status: list.length };
      const delRes = await fetch(`/api/vehicles/${list[0].id}`, { method: 'DELETE' });
      const body = await delRes.json().catch(() => ({}));
      return { ok: true, status: delRes.status, body };
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!('status' in result) || result.status === undefined) throw new Error('missing status');
    expect(result.status).toBe(400);
    expect(result).toMatchObject({
      body: expect.objectContaining({
        error: 'You need at least one vehicle. Add another first.',
      }),
    });
  });

  test('second vehicle enables delete buttons on both cards', async ({ page }) => {
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
    await page.getByTestId('vehicle-max-drive-day-input').fill('6');
    await page.getByTestId('vehicle-max-drive-week-input').fill('30');
    await page.getByTestId('vehicle-max-consecutive-input').fill('3');
    await page.getByTestId('vehicle-water-no').check();
    await page.getByTestId('vehicle-save-button').click();

    // After save the form unmounts and a new VehicleCard appears.
    const card = page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId('vehicle-card-name')).toHaveText(vehicleName);

    // Reload to verify the row was actually persisted in Postgres rather
    // than just rendered optimistically. VehicleProfileSection GETs
    // /api/vehicles after hydration.
    //
    // Register waitForResponse *before* reload (not Promise.all with reload —
    // the listener can miss the fetch if navigation wins the race). Match on
    // URL substring because the browser reports the full origin + path.
    const vehiclesLoaded = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        res.url().includes('/api/vehicles') &&
        !res.url().includes('/api/vehicles/'),
      { timeout: 30_000 },
    );
    await page.reload({ waitUntil: 'load' });
    await vehiclesLoaded;
    await expect(
      page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('vehicle-solo-reminder')).toHaveCount(0);
    await expect(page.getByTestId('vehicle-delete-button')).toHaveCount(2);
  });
});
