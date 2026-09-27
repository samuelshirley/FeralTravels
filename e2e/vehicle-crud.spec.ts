import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';

/**
 * Vehicles, from the server's side.
 *
 * The screen — the solo-vehicle hint, adding a second, both becoming deletable,
 * the new one surviving a relaunch — is driven on the phone by
 * mobile/maestro/vehicles.yaml (2026-09-27). What stays here is the rule the
 * screen only reflects: the server refuses to delete an account's last vehicle,
 * whatever a client asks.
 */
test.describe('Vehicles', () => {
  test('the API refuses to delete the only vehicle', async ({ page }) => {
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
});
