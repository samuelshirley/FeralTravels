import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { FIXTURE_VEHICLE_NAME } from './fixtures/constants';
import { openTrip } from './fixtures/nav';

/**
 * The core read path: a signed-in user opens their trip and sees it.
 *
 * Fresh user per test, so the seeded graph is exactly one trip with two legs
 * and one vehicle — which is why the counts below can be literal numbers.
 */
test.describe('Opening an existing trip', () => {
  test('shows the trip, its vehicle, its two days, and the map', async ({ page }) => {
    await signInAsNewUser(page);

    await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
    await openTrip(page);

    await expect(page.getByText('Trip not found')).toBeHidden();
    await expect(page.getByTitle(`Trip vehicle: ${FIXTURE_VEHICLE_NAME}`)).toContainText(
      FIXTURE_VEHICLE_NAME,
    );

    await expect(page.getByTestId('leg-card')).toHaveCount(2);

    const map = page.getByTestId('trip-map');
    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute('data-map-ready', 'true', { timeout: 30_000 });
    await expect(map).toHaveAttribute('data-leg-count', '2');
  });

  test('a day links out to Google Maps navigation', async ({ page }) => {
    await signInAsNewUser(page);

    await openTrip(page);

    const firstDay = page.getByTestId('leg-card').first();
    await expect(firstDay).toBeVisible({ timeout: 15_000 });
    await firstDay.click();

    // Headless has no GPS, so the smart "Navigate to next stop" button doesn't
    // appear and we get the plain stop list. Seeded legs have no intermediate
    // stops, so there is exactly one link: the destination.
    const navLink = firstDay.getByTestId('nav-stop-link');
    await expect(navLink).toHaveCount(1);
    await expect(navLink).toContainText('Strasbourg');
    await expect(navLink).toHaveAttribute('target', '_blank');

    const href = new URL((await navLink.getAttribute('href'))!);
    expect(href.hostname).toContain('google.com');
    expect(href.pathname).toBe('/maps/dir/');
    expect(href.searchParams.get('dir_action')).toBe('navigate');
    expect(href.searchParams.get('destination')).toBeTruthy();
  });
});
