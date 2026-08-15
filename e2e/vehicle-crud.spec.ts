import { test, expect } from '@playwright/test';
import { createFreshUser, loginViaOtp } from './fixtures/auth';
import { playwrightName } from './fixtures/constants';
import { seedCanonicalFixture } from './fixtures/test-trip';

/**
 * Vehicle CRUD round-trip on the Settings page. Independent of every
 * other test — uses a unique playwright-prefixed name so cleanup can
 * find and remove it after the suite finishes.
 *
 * What we cover here:
 *   - Solo vehicle: reminder banner + no Delete controls (exactly fixture van)
 *   - Sole-vehicle DELETE returns 400
 *   - Add a second vehicle, reload: reminder hidden; exactly two cards and two
 *     Delete buttons (each test signs in as a FRESH user with a freshly seeded
 *     sole van, so counts are deterministic — including on CI retries)
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
    const user = createFreshUser();
    await seedCanonicalFixture(user.email);
    await loginViaOtp(page, user, { redirectTo: '/settings' });
    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();

    // Wait for the vehicles fetch to settle (a card is rendered) BEFORE
    // asserting on the reminder — it only renders after /api/vehicles
    // resolves, which can exceed 10s on a cold CI preview (run #27 flake).
    await expect(page.getByTestId('vehicle-card').first()).toBeVisible({ timeout: 30_000 });

    // Neutral explanatory hint (why Delete is hidden), NOT the old red
    // "You need at least one vehicle." danger banner — that copy read like
    // "you have no vehicle" to a user who has exactly one.
    await expect(page.getByTestId('vehicle-solo-reminder')).toBeVisible();
    await expect(page.getByTestId('vehicle-solo-reminder')).toContainText(
      "This is your only vehicle, so it can't be deleted.",
    );

    await expect(page.getByTestId('vehicle-card').getByTestId('vehicle-delete-button')).toHaveCount(
      0,
    );
  });

  test('delete API rejects removing the sole vehicle', async ({ page }) => {
    const user = createFreshUser();
    await seedCanonicalFixture(user.email);
    await loginViaOtp(page, user, { redirectTo: '/settings' });

    const result = await page.evaluate(async () => {
      const listRes = await fetch('/api/vehicles');
      if (!listRes.ok)
        return { ok: false, step: 'list', status: listRes.status };
      const list = (await listRes.json()) as { id: string }[];
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

  test('second vehicle enables Delete on both cards after reload', async ({ page }) => {
    // Fresh user per test: no stale playwright-prefixed rows can exist, so
    // "exactly two cards" (seeded van + the one we add) is deterministic —
    // including on CI retries, which get a brand-new user.
    const user = createFreshUser();
    await seedCanonicalFixture(user.email);

    const vehicleName = playwrightName('Test Van');

    await loginViaOtp(page, user, { redirectTo: '/settings' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // The fixture seed always installs `E2E Fixture Van` on this user,
    // so there's always at least one card visible. We don't depend on
    // its presence — just want to make sure the section rendered.
    await expect(page.getByRole('heading', { name: 'Vehicle profile' })).toBeVisible();

    await page.getByTestId('add-vehicle-button').click();
    await expect(page.getByTestId('vehicle-form')).toBeVisible();

    // MVP vehicle form is name + comfortable range (+ optional hard-max ceiling).
    // Travel style / max-consecutive-days / dump-station fields were removed
    // (migrations 0014/0015) — do NOT reintroduce selectors for them.
    await page.getByTestId('vehicle-name-input').fill(vehicleName);
    await page.getByTestId('vehicle-refill-input').fill('400');
    await page.getByTestId('vehicle-save-button').click();

    // After save the form unmounts and a new VehicleCard appears.
    const card = page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId('vehicle-card-name')).toHaveText(vehicleName);

    // Reload to verify the row was actually persisted in Postgres rather
    // than just rendered optimistically. Assert on rendered cards — more
    // reliable than waitForResponse after a long Penny test leaves the
    // server warm and reload timing noisy.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.locator(`[data-testid="vehicle-card"][data-vehicle-name="${vehicleName}"]`),
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('vehicle-solo-reminder')).toHaveCount(0);
    await expect(page.getByTestId('vehicle-card')).toHaveCount(2);
    await expect(page.getByTestId('vehicle-delete-button')).toHaveCount(2);
  });
});
