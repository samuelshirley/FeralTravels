import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { playwrightName } from './fixtures/constants';

/**
 * Vehicles on the Settings page.
 *
 * Fresh user per test, each seeded with exactly one van, so "one card" and
 * "two cards" are literal — and no test can be disturbed by another adding or
 * deleting a vehicle beside it.
 */
test.describe('Vehicles', () => {
  test('the only vehicle cannot be deleted, and says so', async ({ page }) => {
    await signInAsNewUser(page, { redirectTo: '/settings' });

    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();
    await expect(page.getByTestId('vehicle-card')).toHaveCount(1, { timeout: 30_000 });

    await expect(page.getByTestId('vehicle-solo-reminder')).toContainText(
      "This is your only vehicle, so it can't be deleted.",
    );
    await expect(page.getByTestId('vehicle-delete-button')).toHaveCount(0);
  });

  test('the API also refuses to delete the only vehicle', async ({ page }) => {
    await signInAsNewUser(page, { redirectTo: '/settings' });

    const vehicles = await page.request.get('/api/vehicles');
    expect(vehicles.ok()).toBe(true);
    const list = (await vehicles.json()) as { id: string }[];
    expect(list).toHaveLength(1);

    const deleted = await page.request.delete(`/api/vehicles/${list[0].id}`);
    expect(deleted.status()).toBe(400);
    expect(await deleted.json()).toMatchObject({
      error: 'You need at least one vehicle. Add another first.',
    });
  });

  test('adding a second vehicle makes both deletable, and it persists', async ({ page }) => {
    await signInAsNewUser(page, { redirectTo: '/settings' });
    const vehicleName = playwrightName('Test Van');

    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();
    await page.getByTestId('add-vehicle-button').click();

    await page.getByTestId('vehicle-name-input').fill(vehicleName);
    await page.getByTestId('vehicle-refill-input').fill('400');
    await page.getByTestId('vehicle-save-button').click();

    const newCard = page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`);
    await expect(newCard).toBeVisible({ timeout: 15_000 });

    // Reload: proves it was written, not just rendered optimistically.
    await page.reload();
    await expect(newCard).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('vehicle-card')).toHaveCount(2);
    await expect(page.getByTestId('vehicle-delete-button')).toHaveCount(2);
    await expect(page.getByTestId('vehicle-solo-reminder')).toHaveCount(0);
  });
});
