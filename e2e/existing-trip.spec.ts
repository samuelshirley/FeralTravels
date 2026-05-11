import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { FIXTURE_TRIP_NAME } from './fixtures/constants';

/**
 * Smoke-test the read path for an authenticated user with existing data:
 *
 *   - /trips lists their seeded trip
 *   - Clicking through opens the workspace
 *   - The itinerary renders the expected number of leg cards (2 days)
 *   - The map mounts and reports it loaded the right number of legs
 *
 * The fixture trip is rebuilt with a known shape on every globalSetup
 * (see scripts/seed-e2e-fixture.ts), so the assertions below pin to
 * literal numbers without being flaky.
 */
test.describe('Existing user with seeded trip', () => {
  test('trip is visible on /trips, opens, and renders legs + map', async ({ page }) => {
    await loginAsFixtureUser(page);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();

    const fixtureCard = page.locator(`[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`);
    await expect(fixtureCard).toBeVisible();

    // The card itself contains an <a> wrapper to /trips/<id>; click the
    // visible name link to open the workspace.
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/\d+/, { timeout: 15_000 });

    // Itinerary: `seed-e2e-fixture.ts` always inserts exactly two legs (Day 1 +
    // Day 2). Exact count catches silent seed drift / duplicate trips.
    const legCards = page.getByTestId('leg-card');
    await expect(legCards.first()).toBeVisible({ timeout: 15_000 });
    const legCount = await legCards.count();
    expect(legCount).toBe(2);

    // Map mounts and reports the right leg count via data attribute.
    const map = page.getByTestId('trip-map');
    await expect(map).toBeVisible();
    // Wait for Google Maps to finish loading — data-map-ready flips to
    // 'true' once the importLibrary resolved and the Map instance was
    // constructed.
    await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 30_000 });
    await expect(map).toHaveAttribute('data-leg-count', '2');

    // Smoke-check the actual Google Maps DOM rendered. Google injects a
    // `gm-style` div inside the container once the basemap is ready; if
    // we got here without it we have a tile-load problem (usually a bad
    // NEXT_PUBLIC_GOOGLE_MAPS_API_KEY).
    await expect(map.locator('.gm-style').first()).toBeVisible({ timeout: 30_000 });
  });
});
