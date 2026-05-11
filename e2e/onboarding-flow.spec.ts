import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { createOnboardingTrip } from './fixtures/test-trip';
import { FIXTURE_VEHICLE_NAME } from './fixtures/constants';

/**
 * Exercises the pre-Penny onboarding wizard: units → vehicle pick → handoff
 * prompt. No LLM calls; the fixture user already has a fuel-ready default van.
 */
test.describe('Onboarding wizard', () => {
  test('units pick, vehicle pick, then handoff question', async ({ page }) => {
    const { tripId } = await createOnboardingTrip('Onboarding Flow');

    await loginAsFixtureUser(page, { redirectTo: `/trips/${tripId}` });

    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Metric (km)' }).click();

    await expect(page.getByText('Which vehicle are you taking on this trip?')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: FIXTURE_VEHICLE_NAME }).click();

    await expect(
      page.getByText('Where do you want to go? Tell me like you would a friend.'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByPlaceholder(/Spain → Portugal/i)).toBeVisible();
  });
});
