import { test, expect } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createVehicleNewProfileTrip, seedCanonicalFixture } from './fixtures/test-trip';

/**
 * The range question is a safety number, so the composer must reject a value
 * below the 200 km minimum rather than quietly saving it.
 */
test.describe('Onboarding validation', () => {
  test('rejects a range below the minimum, then accepts a valid one', async ({ page }) => {
    const email = uniqueEmail();
    await seedCanonicalFixture(email);
    const { tripId, vehicleId } = await createVehicleNewProfileTrip(email, 'Onboarding Validation');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');
    await expect(page.getByText(/driving range/i)).toBeVisible({ timeout: 30_000 });

    await composer.fill('50');
    await composer.press('Enter');
    await expect(page.getByText(/200/)).toBeVisible({ timeout: 15_000 });

    // The rejected answer must not have been saved.
    const before = await (await page.request.get(`/api/vehicles/${vehicleId}`)).json();
    expect(before.range_km).toBeNull();

    await composer.fill('400');
    await composer.press('Enter');
    // Range accepted — it's the LAST onboarding question now, so there is no
    // echo bubble to wait for: onboarding completes and hands off to Penny.
    // The real claim is that the number landed on the vehicle row.
    await expect
      .poll(
        async () => (await (await page.request.get(`/api/vehicles/${vehicleId}`)).json()).range_km,
        { timeout: 25_000 },
      )
      .toBe(400);
  });
});
