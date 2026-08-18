import { test, expect } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createOnboardingTrip, seedCanonicalFixture } from './fixtures/test-trip';

/**
 * The onboarding wizard: intent -> start date -> units. The vehicle step is
 * skipped automatically because the seeded user has exactly one fuel-ready van.
 *
 * There is no trip-naming step (Penny names the trip from its route) and this
 * test guards that it never comes back.
 */
test.describe('Onboarding wizard', () => {
  test('asks for the trip, the date and units — and never for a name', async ({ page }) => {
    const email = uniqueEmail();
    await seedCanonicalFixture(email);
    const { tripId } = await createOnboardingTrip(email, 'Onboarding Flow');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');

    await expect(page.getByText(/Tell me where you want to go/)).toBeVisible({ timeout: 30_000 });
    await composer.fill('Road trip from Girona to Berlin');
    await composer.press('Enter');

    await expect(page.getByText(/What would you like to name this trip/)).toHaveCount(0);

    await expect(page.getByText(/When are you setting off/)).toBeVisible({ timeout: 20_000 });
    await composer.fill('June 3 2026');
    await composer.press('Enter');

    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Metric (km)' }).click();
  });
});
