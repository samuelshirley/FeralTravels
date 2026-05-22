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

      await expect(page.getByText(/How far between fuel stops/i)).toBeVisible({ timeout: 25_000 });

      const composer = page.getByTestId('trip-chat-composer');
      await composer.fill('50');
      await composer.press('Enter');

      await expect(page.getByText(/Must be at least 200/i)).toBeVisible({ timeout: 10_000 });

      await composer.fill('400');
      await composer.press('Enter');

      await expect(page.getByText(/What's your travel style/i)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await deleteVehicleNewProfileFixture({ tripId, vehicleId });
    }
  });
});
