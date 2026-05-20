import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { createOnboardingTrip } from './fixtures/test-trip';

/**
 * Exercises the pre-Penny onboarding wizard:
 *   trip_intent → trip_name → units_pick → (vehicle auto-pick when only one
 *   fuel-complete vehicle) → done.
 * No LLM calls; the fixture user already has a fuel-ready default van.
 */
test.describe('Onboarding wizard', () => {
  test('units pick, single vehicle auto-selected, then handoff question', async ({ page }) => {
    const { tripId } = await createOnboardingTrip('Onboarding Flow');

    await loginAsFixtureUser(page, { redirectTo: `/trips/${tripId}` });

    // Step 1: trip_intent — Penny's greeting with the trip intent textarea
    await expect(
      page.getByText(/Tell me where you want to go/),
    ).toBeVisible({ timeout: 20_000 });

    const composer = page.getByTestId('trip-chat-composer');
    await composer.fill('Road trip from Girona to Berlin');
    await composer.press('Enter');

    // Step 2: trip_name — "What would you like to name this trip?"
    await expect(
      page.getByText(/What would you like to name this trip/),
    ).toBeVisible({ timeout: 15_000 });

    await composer.fill('E2E Onboarding Trip');
    await composer.press('Enter');

    // Step 3: units_pick — metric or imperial
    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Metric (km)' }).click();
  });
});
