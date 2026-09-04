import { test, expect } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createOnboardingTrip } from './fixtures/test-trip';
import { seededTripStartPhrase } from './fixtures/constants';

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
    /*
     * Deliberately NOT `seedCanonicalFixture` — that seeds a COMPLETE vehicle
     * (name and range), and `vehicle_new` adopts the account's single owned
     * vehicle, so onboarding would finish at units and the vehicle card would
     * never be reached. A first-run account owns no vehicle, which is the
     * whole condition the composite card is offered under.
     */
    const { tripId } = await createOnboardingTrip(email, 'Onboarding Flow');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');

    // The greeting, which this branch cut from 69 words to 15. Matched on a
    // distinctive fragment rather than the whole sentence so a later reword of
    // the tail does not red the suite for no behavioural reason.
    await expect(page.getByText(/Where are we going\?/)).toBeVisible({ timeout: 30_000 });
    await composer.fill('Road trip from Girona to Berlin');
    await composer.press('Enter');

    await expect(page.getByText(/What would you like to name this trip/)).toHaveCount(0);

    await expect(page.getByText(/When are you setting off/)).toBeVisible({ timeout: 20_000 });
    await composer.fill(seededTripStartPhrase());
    await composer.press('Enter');

    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Metric (km)' }).click();

    /*
     * The composite vehicle card (frame 7e): nickname and range on ONE card,
     * finishing the setup in one submit where there used to be two steps.
     *
     * The composer is asserted READ-ONLY while it is up. That is the property
     * worth holding: the card carries two answers submitted together, so a
     * live composer would be a second way to answer that cannot work, and
     * "the composer is live" is exactly the bug the `chips` kind was added to
     * preserve on OTHER steps.
     */
    const card = page.getByTestId('onboarding-vehicle-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(composer).toHaveAttribute('readonly', /.*/);

    await page.getByTestId('onboarding-vehicle-name').fill('Duncan');
    await page.getByRole('button', { name: '500 km' }).click();
    await page.getByTestId('onboarding-vehicle-submit').click();

    // One submit ends onboarding: the card goes, and the composer is a live
    // chat box again rather than a form field.
    await expect(card).toBeHidden({ timeout: 25_000 });
    await expect(composer).not.toHaveAttribute('readonly', /.*/);
  });
});
