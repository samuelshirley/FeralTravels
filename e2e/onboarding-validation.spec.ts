import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import {
  createVehicleNewProfileTrip,
  deleteVehicleNewProfileFixture,
} from './fixtures/test-trip';

test.describe('Onboarding composer validation', () => {
  test('rejects fuel spacing below minimum then accepts valid value', async ({ page }) => {
    const { tripId, vehicleId } = await createVehicleNewProfileTrip('Onboarding Validation');
    try {
      await loginAsFixtureUser(page, { redirectTo: `/trips/${tripId}` });

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
      await deleteVehicleNewProfileFixture({ tripId, vehicleId });
    }
  });
});
