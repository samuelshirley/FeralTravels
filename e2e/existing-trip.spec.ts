import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { FIXTURE_TRIP_NAME, FIXTURE_VEHICLE_NAME } from './fixtures/constants';

/**
 * Smoke-test the read path for an authenticated user with a set-up vehicle and
 * an existing trip (core happy path for the trip workspace):
 *
 *   - /trips lists their seeded trip
 *   - The trip opens with the fixture default vehicle on the chip
 *   - The itinerary renders the expected number of leg cards (2 days)
 *   - The map mounts and reports it loaded the right number of legs
 *
 * The fixture is re-seeded over HTTP on every globalSetup (via /api/test/seed →
 * seedFixture in repos/testSupport.ts), so the assertions pin to literal numbers.
 */
test.describe('Existing user with seeded trip', () => {
  test('trip on /trips opens with the default vehicle, legs + map', async ({
    page,
  }) => {
    await loginAsFixtureUser(page);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();

    const fixtureCard = page.locator(`[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`);
    await expect(fixtureCard).toBeVisible();

    // The card itself contains an <a> wrapper to /trips/<id>; click the
    // visible name link to open the workspace. 30s: against the CI preview
    // the first workspace navigation can hit cold serverless functions +
    // Neon branch wake-up (this exact wait flaked at 15s in run #26 while
    // the same click passed in the next test at ~3s).
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/, { timeout: 30_000 });

    await expect(page.getByText('Trip not found')).not.toBeVisible({ timeout: 10_000 });

    // Vehicle chip is display-only (no picker) — just shows the vehicle name.
    const vehicleChip = page.getByTitle(`Trip vehicle: ${FIXTURE_VEHICLE_NAME}`);
    await expect(vehicleChip).toBeVisible();
    await expect(vehicleChip).toContainText(FIXTURE_VEHICLE_NAME);

    // Itinerary: the seed always creates exactly two legs (Day 1 + Day 2).
    // Exact count catches silent seed drift / duplicate trips.
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

  test('leg cards render navigation links to Google Maps', async ({ page }) => {
    await loginAsFixtureUser(page);

    const fixtureCard = page.locator(`[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`);
    await expect(fixtureCard).toBeVisible();
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/, { timeout: 15_000 });

    const legCards = page.getByTestId('leg-card');
    await expect(legCards.first()).toBeVisible({ timeout: 15_000 });

    // Expand the first leg card to reveal the navigation link(s).
    await legCards.first().click();

    // The nav UI is GPS-aware: if the browser has geolocation and the
    // user is near the route, it shows a single smart "Navigate to ..."
    // button (data-testid="nav-next-stop"). Otherwise it falls back to
    // a list of stop links (data-testid="nav-stop-link").
    //
    // In Playwright (headless, no GPS) the hook will get 'unavailable'
    // or 'denied', so we expect the fallback list. Seeded legs have no
    // intermediate stops, so the list has exactly one entry (the
    // destination: "Strasbourg, France").
    const stopLinks = legCards.first().getByTestId('nav-stop-link');
    await expect(stopLinks.first()).toBeVisible({ timeout: 5_000 });

    // With no intermediate stops, exactly one link (the destination).
    const linkCount = await stopLinks.count();
    expect(linkCount).toBe(1);

    // The link should point to Google Maps with dir_action=navigate,
    // no waypoints, and NO origin (uses device GPS on mobile).
    const href = await stopLinks.first().getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.hostname).toContain('google.com');
    expect(url.pathname).toBe('/maps/dir/');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    expect(url.searchParams.get('travelmode')).toBe('driving');
    expect(url.searchParams.has('waypoints')).toBe(false);
    expect(url.searchParams.has('origin')).toBe(false);
    expect(url.searchParams.get('destination')).toBeTruthy();

    // Opens in a new tab.
    expect(await stopLinks.first().getAttribute('target')).toBe('_blank');

    // The link text should include the destination name.
    await expect(stopLinks.first()).toContainText('Strasbourg');
  });
});
