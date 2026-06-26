import { test, expect, type Request } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { FIXTURE_TRIP_NAME } from './fixtures/constants';

/**
 * Lazy fuel sourcing on day-open (migration 0013).
 *
 * Fuel stops are no longer fanned out eagerly across the whole trip during
 * planning (the old Google Places cost sink). Instead, when the user EXPANDS a
 * day, `LegCard`'s effect POSTs to `/api/legs/:id/fuel-stops`, which sources
 * that one leg lazily (cache-aware on the server). See CLAUDE.md → "Lazy fuel
 * sourcing" and src/components/LegCard.tsx.
 *
 * We assert the *trigger behaviour* — that opening a day fires the lazy POST,
 * and that merely loading the trip does NOT — rather than the search results.
 * The seeded legs have no `fuel_status` (defaults to 'none'), so a never-sourced
 * leg always runs the fetch on first open. Asserting on the request (not on
 * returned stations) keeps the test deterministic and independent of whether
 * Google Places returns stations in the CI environment.
 */
const FUEL_STOPS_POST = /\/api\/legs\/[0-9a-f-]{36}\/fuel-stops/;

function isLazyFuelPost(req: Request): boolean {
  return req.method() === 'POST' && FUEL_STOPS_POST.test(req.url());
}

test.describe('Lazy fuel sourcing on day-open', () => {
  test('opening a day fires the lazy fuel POST; loading the trip alone does not', async ({
    page,
  }) => {
    // Record every lazy fuel POST so we can assert ordering relative to expand.
    const fuelPosts: string[] = [];
    page.on('request', (req) => {
      if (isLazyFuelPost(req)) fuelPosts.push(req.url());
    });

    await loginAsFixtureUser(page);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();

    const fixtureCard = page.locator(
      `[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`,
    );
    await expect(fixtureCard).toBeVisible();
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/, { timeout: 15_000 });

    const legCards = page.getByTestId('leg-card');
    await expect(legCards.first()).toBeVisible({ timeout: 15_000 });

    // Laziness: with all days collapsed, the trip view must NOT have sourced
    // fuel. Give the page a beat to settle so a stray eager fetch would show.
    await page.waitForTimeout(1_000);
    expect(
      fuelPosts,
      'no fuel should be sourced before a day is opened',
    ).toHaveLength(0);

    // Open the first day and assert the lazy POST fires for it.
    const firstFuelPost = page.waitForRequest(isLazyFuelPost, { timeout: 15_000 });
    await legCards.first().click();
    const req = await firstFuelPost;
    expect(req.method()).toBe('POST');
    expect(req.url()).toMatch(FUEL_STOPS_POST);
  });
});
