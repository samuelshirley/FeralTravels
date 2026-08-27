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

    // Seeded legs have no intermediate stops, so there is exactly one link: the
    // destination. Note the count is asserted, not the GPS state — the card no
    // longer has a branch that renders fewer buttons when GPS is available.
    const navLink = firstDay.getByTestId('nav-stop-link');
    await expect(navLink).toHaveCount(1);
    await expect(navLink).toContainText('Strasbourg');
    await expect(navLink).toHaveAttribute('target', '_blank');

    // The invariant, asserted through the DOM: a day that offers navigation at
    // all must offer a way to the END of the day. Regression guard for
    // 2026-08-26, when a live trip rendered a single button to a fuel stop
    // 398 km out and nothing at all that routed to the destination.
    await expect(firstDay.locator('[data-nav-stop-type="destination"]')).toHaveCount(1);

    const href = new URL((await navLink.getAttribute('href'))!);
    expect(href.hostname).toContain('google.com');
    expect(href.pathname).toBe('/maps/dir/');
    expect(href.searchParams.get('dir_action')).toBe('navigate');
    expect(href.searchParams.get('destination')).toBeTruthy();
  });

  test('every driving day can be navigated to its destination', async ({ page }) => {
    await signInAsNewUser(page);
    await openTrip(page);

    const days = page.getByTestId('leg-card');
    await expect(days.first()).toBeVisible({ timeout: 15_000 });

    const count = await days.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const day = days.nth(i);
      await day.click();

      // Base days (leg_type 'rest') sit at one place and render no nav list;
      // every driving day must render exactly one destination button.
      const navLinks = day.getByTestId('nav-stop-link');
      const total = await navLinks.count();
      if (total === 0) continue;

      await expect(
        day.locator('[data-nav-stop-type="destination"]'),
        `day ${i + 1} shows ${total} nav button(s) but none route to its destination`
      ).toHaveCount(1);

      await day.click();
    }
  });
});
