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
    const { tripId } = await createVehicleNewProfileTrip(email, 'Onboarding Validation');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');
    await expect(page.getByText(/driving range/i)).toBeVisible({ timeout: 30_000 });

    await composer.fill('50');
    await composer.press('Enter');
    await expect(page.getByText(/200/)).toBeVisible({ timeout: 15_000 });

    await composer.fill('400');
    await composer.press('Enter');
    // Range accepted — the answer bubble echoes it back and onboarding moves on.
    await expect(page.getByText(/400\s?km/i)).toBeVisible({ timeout: 25_000 });
  });
});
