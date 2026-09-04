import { test, expect } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createOnboardingTrip } from './fixtures/test-trip';
import type { Page } from '@playwright/test';

/** A right-aligned user bubble carrying exactly this text. */
const userBubble = (page: Page, text: string) =>
  page.locator('[data-testid="chat-message"][data-message-role="user"]').filter({ hasText: text });

/**
 * The onboarding wizard: intent -> origin -> start date -> pace -> units -> vehicle.
 *
 * A FIRST-RUN account (`createOnboardingTrip`, deliberately not
 * `seedCanonicalFixture` — a seeded, complete vehicle skips the vehicle card
 * entirely). The wizard's shape is asserted through the DOM as a driver sees
 * it, because that is where every one of these regressed (2026-09-04):
 *
 *   - a chip tap on the date step did nothing (renderer drew chips for
 *     `select || chips`, handler accepted `select` only);
 *   - an opening message with no origin was never asked for one, so Penny's
 *     first real turn was "where are you starting from?" and nothing planned;
 *   - the handoff replayed the stored intent as a user bubble under the last
 *     question, and the final answer never got a bubble of its own.
 *
 * There is no trip-naming step (Penny names the trip from its route) and this
 * file guards that it never comes back.
 */
test.describe('Onboarding wizard', () => {
  test('asks origin, date (by chip), units, vehicle — and hands off cleanly', async ({ page }) => {
    const email = uniqueEmail();
    const { tripId } = await createOnboardingTrip(email, 'Onboarding Flow');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');

    // The greeting. Matched on a distinctive fragment so a reword of the tail
    // does not red the suite for no behavioural reason.
    await expect(page.getByText(/Where are we going\?/)).toBeVisible({ timeout: 30_000 });
    // The step counter lives in the header (frame 7b), never in a strip.
    await expect(page.getByTestId('onboarding-progress')).toHaveText(/1 OF \d/);

    // A destination with NO origin. Whether the scan runs (needs Anthropic)
    // or returns all-null (no key), this message names no start, so the
    // origin step must come BEFORE the date — that is the ordering under test.
    await composer.fill('Road trip to Berlin');
    await composer.press('Enter');

    await expect(page.getByText(/What would you like to name this trip/)).toHaveCount(0);

    const originQ = page.getByText(/Where are you starting from\?|Are you leaving from/);
    await expect(originQ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/When are you setting off/)).toHaveCount(0);
    // The answer stays in the transcript as an ordinary user bubble (item 9).
    await expect(userBubble(page, 'Road trip to Berlin')).toHaveCount(1);

    await composer.fill('Girona');
    await composer.press('Enter');

    await expect(page.getByText(/When are you setting off/)).toBeVisible({ timeout: 20_000 });
    await expect(userBubble(page, 'Girona')).toHaveCount(1);

    /*
     * THE CHIP TAP. This was dead: three chips rendered, none accepted a
     * tap. The date step is `kind: 'chips'`, so the composer stays live AND
     * the chip must submit — the next question is the proof the step advanced.
     */
    await expect(composer).not.toHaveAttribute('readonly', /.*/);
    await page.getByRole('button', { name: 'In a month', exact: true }).click();

    // The pace step: how long a driving day should be. A chip again, and
    // the composer stays live for any other number.
    await expect(page.getByText(/How long do you want to drive each day/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '6 h', exact: true }).click();
    await expect(userBubble(page, '6 h a day')).toHaveCount(1);

    await expect(
      page.getByText('Do you want distances in metric (kilometers) or imperial (miles)?'),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Metric (km)' }).click();

    /*
     * The composite vehicle card (frame 7e): nickname and range on ONE card,
     * inside Penny's bubble. The composer is asserted READ-ONLY while it is
     * up: the card carries two answers submitted together, so a live composer
     * would be a second way to answer that cannot work.
     */
    const card = page.getByTestId('onboarding-vehicle-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(composer).toHaveAttribute('readonly', /.*/);

    await page.getByTestId('onboarding-vehicle-name').fill('Duncan');
    await page.getByRole('button', { name: '500 km' }).click();
    await page.getByTestId('onboarding-vehicle-submit').click();

    // One submit ends onboarding: the card goes, the composer is a live chat
    // box again.
    await expect(card).toBeHidden({ timeout: 25_000 });
    await expect(composer).not.toHaveAttribute('readonly', /.*/);

    /*
     * THE HANDOFF. The stored intent is fired at Penny as a `handoff` row —
     * a message for her, not a bubble for the transcript. Before this fix it
     * rendered as if the driver had just typed "Road trip to Berlin" a SECOND
     * time, under the range question, and the real final answer never
     * rendered at all. So: the intent appears exactly once (its own answer,
     * up top), and the vehicle answer is the last user bubble.
     */
    await expect(userBubble(page, 'Duncan · 500 km')).toHaveCount(1);
    await expect(userBubble(page, 'Road trip to Berlin')).toHaveCount(1);
  });

  test('an opening message that names both ends skips the origin step', async ({ page }) => {
    // The scan that reads the origin out of the message is an Anthropic call.
    test.skip(!process.env.ANTHROPIC_API_KEY?.trim(), 'ANTHROPIC_API_KEY not set');
    const email = uniqueEmail();
    const { tripId } = await createOnboardingTrip(email, 'Onboarding Origin Skip');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByTestId('trip-chat-composer');
    await expect(page.getByText(/Where are we going\?/)).toBeVisible({ timeout: 30_000 });
    await composer.fill('Road trip from Girona to Berlin');
    await composer.press('Enter');

    // Straight to the date: the origin was read out of the message and
    // acknowledged, never asked.
    await expect(page.getByText(/When are you setting off/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Where are you starting from\?|Are you leaving from/)).toHaveCount(0);
    await expect(page.getByText(/starting from Girona/)).toBeVisible();
  });
});
