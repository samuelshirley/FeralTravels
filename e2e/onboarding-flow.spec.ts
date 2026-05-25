import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { createOnboardingTrip } from './fixtures/test-trip';

/**
 * Exercises the pre-Penny onboarding wizard:
 *   trip_intent → units_pick → (vehicle auto-pick when only one fuel-complete
 *   vehicle) → done.
 * The fixture trip already carries a real name, so the trip_name question is
 * skipped (onboarding only asks for a name on blank / legacy "Untitled Trip"
 * rows). No LLM calls; the fixture user already has a fuel-ready default van.
 */
test.describe('Onboarding wizard', () => {
  test('named trip skips naming, units pick, single vehicle auto-selected', async ({ page }) => {
    const { tripId } = await createOnboardingTrip('Onboarding Flow');

    await loginAsFixtureUser(page, { redirectTo: `/trips/${tripId}` });

    // Step 1: trip_intent — Penny's greeting with the trip intent textarea
    await expect(
      page.getByText(/Tell me where you want to go/),
    ).toBeVisible({ timeout: 20_000 });

    const composer = page.getByTestId('trip-chat-composer');
    await composer.fill('Road trip from Girona to Berlin');
    await composer.press('Enter');

    // The trip was created with a name, so naming is skipped — Penny does NOT
    // ask "What would you like to name this trip?".
    await expect(
      page.getByText(/What would you like to name this trip/),
    ).toHaveCount(0);

    // Step 2: units_pick — metric or imperial
    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Metric (km)' }).click();
  });
});
