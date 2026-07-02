import { test, expect } from '@playwright/test';
import { createFreshUser, loginViaOtp, MAILSLURP_API_KEY, SKIP_NO_MAILSLURP } from './fixtures/auth';
import {
  cleanupPlaywrightFixtureData,
  createVehicleNewProfileTrip,
  seedCanonicalFixture,
} from './fixtures/test-trip';

test.describe('Onboarding composer validation', () => {
  test.skip(!MAILSLURP_API_KEY, SKIP_NO_MAILSLURP);

  test('rejects fuel spacing below minimum then accepts valid value', async ({ page }) => {
    const user = await createFreshUser();
    await seedCanonicalFixture(user.email);
    const { tripId } = await createVehicleNewProfileTrip(user.email, 'Onboarding Validation');
    try {
      await loginViaOtp(page, user, { redirectTo: `/trips/${tripId}` });

      await expect(page.getByText(/comfortable driving range/i)).toBeVisible({ timeout: 25_000 });

      const composer = page.getByTestId('trip-chat-composer');
      await composer.fill('50');
      await composer.press('Enter');

      // Out-of-band value is rejected with the 200 km minimum.
      await expect(page.getByText(/200/)).toBeVisible({ timeout: 10_000 });

      await composer.fill('400');
      await composer.press('Enter');

      // The only remaining vehicle question is the optional hard-max ceiling.
      // Match the current prompt copy (vehicleProfile.ts hard_max_range_km label).
      await expect(page.getByText(/hard max fuel range/i)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await cleanupPlaywrightFixtureData(user.email);
    }
  });
});
