import { test, expect } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { createBlankPlanningTrip, countLegs, seedCanonicalFixture } from './fixtures/test-trip';

/**
 * Penny plans a real trip. This calls Anthropic for real and costs real money
 * (~$0.05-0.20 a run), which is the point: it catches a broken planner before
 * production does.
 *
 * We assert the SHAPE of the result, never Penny's wording — the model rephrases
 * itself run to run, and a fuzzy text match would be either useless or brittle.
 */
test.describe('Penny plans a trip', () => {
  test.skip(!process.env.ANTHROPIC_API_KEY?.trim(), 'ANTHROPIC_API_KEY not set');
  test.setTimeout(240_000);

  const PROMPT =
    'Plan a driving route from Girona, Spain to Berlin, Germany over 14 days. ' +
    'Route through the Alps: Italy into Austria, scenic where Google Directions can still find paved roads. ' +
    'If a segment is tight on time, keep the itinerary feasible within the 14 days.';

  test('Girona to Berlin produces a multi-day plan that renders', async ({ page }) => {
    const email = uniqueEmail();
    await seedCanonicalFixture(email);
    const { tripId } = await createBlankPlanningTrip(email, 'Penny Submit Test');
    await login(page, email, `/trips/${tripId}`);

    const composer = page.getByPlaceholder('Ask Penny…');
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill(PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('Changes applied to trip')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Penny is typing')).toBeHidden({ timeout: 60_000 });

    // Read the legs from the API, not the list — the itinerary lazy-renders and
    // counting visible cards undercounts a long plan.
    const legs = await countLegs(page, tripId);
    expect(legs, 'Penny should have produced a multi-day plan').toBeGreaterThanOrEqual(3);

    await page.reload();
    await expect(page.getByTestId('leg-card').first()).toBeVisible({ timeout: 30_000 });

    const map = page.getByTestId('trip-map');
    await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 30_000 });

    const pageText = (await page.locator('body').innerText()).toLowerCase();
    expect(pageText).toContain('girona');
    expect(pageText).toContain('berlin');
  });
});
