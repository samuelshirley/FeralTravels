import { test, expect } from '@playwright/test';
import { loginAsFixtureUser } from './fixtures/auth';
import { FIXTURE_TRIP_NAME, FIXTURE_VEHICLE_NAME } from './fixtures/constants';

/**
 * Smoke-test the read path for an **authenticated user with a fully set-up
 * vehicle** and an existing trip (core happy path for trip workspace):
 *
 *   - /trips lists their seeded trip
 *   - The trip opens with the fixture **default vehicle** on the chip
 *     (all remediation-required fields filled in seed data — see
 *     `vehicleIsCompleteForRemediation` / scripts/seed-e2e-fixture.ts)
 *   - No vehicle-profile remediation overlay (`Update your vehicle`)
 *   - The itinerary renders the expected number of leg cards (2 days)
 *   - The map mounts and reports it loaded the right number of legs
 *
 * The fixture is rebuilt on every globalSetup (see scripts/seed-e2e-fixture.ts),
 * so the assertions below pin to literal numbers without being flaky.
 */
test.describe('Existing user with seeded trip', () => {
  test('trip on /trips opens with complete default vehicle, no remediation, legs + map', async ({
    page,
  }) => {
    await loginAsFixtureUser(page);
    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();

    const fixtureCard = page.locator(`[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`);
    await expect(fixtureCard).toBeVisible();

    // The card itself contains an <a> wrapper to /trips/<id>; click the
    // visible name link to open the workspace.
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/\d+/, { timeout: 15_000 });

    await expect(page.getByText('Trip not found')).not.toBeVisible({ timeout: 10_000 });

    // Seeded user: one complete default vehicle (fuel + strict driving + water gate)
    // and trip.vehicle_id pointed at it — Penny/fuel must not be blocked.
    await expect(page.getByRole('heading', { name: 'Update your vehicle' })).not.toBeVisible();
    const tripVehicleBtn = page.getByRole('button', { name: 'Change trip vehicle' });
    await expect(tripVehicleBtn).toBeVisible();
    await expect(tripVehicleBtn).toContainText(FIXTURE_VEHICLE_NAME);

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

  test('leg cards render segmented navigation links to Google Maps', async ({ page }) => {
    await loginAsFixtureUser(page);

    const fixtureCard = page.locator(`[data-testid="trip-card"][data-trip-name="${FIXTURE_TRIP_NAME}"]`);
    await expect(fixtureCard).toBeVisible();
    await fixtureCard.getByText(FIXTURE_TRIP_NAME, { exact: false }).first().click();
    await page.waitForURL(/\/trips\/\d+/, { timeout: 15_000 });

    const legCards = page.getByTestId('leg-card');
    await expect(legCards.first()).toBeVisible({ timeout: 15_000 });

    // Expand the first leg card to reveal the navigation link.
    await legCards.first().click();

    // Seeded legs have no intermediate stops, so each leg should render
    // a single "Navigate in Google Maps" link (one segment).
    const navLink = legCards.first().getByRole('link', { name: /Navigate in Google Maps/i });
    await expect(navLink).toBeVisible({ timeout: 5_000 });

    // The link should point to Google Maps directions with dir_action=navigate
    // and NO waypoints param (single-segment link = guaranteed Start button).
    const href = await navLink.getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.hostname).toContain('google.com');
    expect(url.pathname).toBe('/maps/dir/');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    expect(url.searchParams.get('travelmode')).toBe('driving');
    expect(url.searchParams.has('waypoints')).toBe(false);
    // Origin and destination should be set (Paris → Strasbourg for Day 1).
    expect(url.searchParams.get('origin')).toBeTruthy();
    expect(url.searchParams.get('destination')).toBeTruthy();

    // The link should open in a new tab (target=_blank).
    expect(await navLink.getAttribute('target')).toBe('_blank');

    // There should NOT be a multi-segment "NAVIGATE (N SEGMENTS)" header
    // since the seeded legs have zero stops.
    await expect(legCards.first().getByText(/NAVIGATE.*SEGMENTS/i)).not.toBeVisible();
  });
});
