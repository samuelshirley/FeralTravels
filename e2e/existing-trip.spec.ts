import { test, expect, request } from '@playwright/test';
import { login, signInAsNewUser, uniqueEmail } from './fixtures/auth';
import {
  FIXTURE_TRIP_NAME,
  FIXTURE_USER_NAME,
  FIXTURE_VEHICLE_NAME,
  testEndpointHeaders,
} from './fixtures/constants';
import { openTrip } from './fixtures/nav';
import { createBlankPlanningTrip } from './fixtures/test-trip';
import { formatDayMonthYear, legDateISO, todayISO } from '../src/lib/dates';

/**
 * The canonical fixture plus one forced Finn fuel stop on day 1, its fuel cache
 * stamped fresh so opening the day neither searches Places nor replaces it.
 */
async function seedWithForcedFuelStop(email: string): Promise<void> {
  const ctx = await request.newContext({
    baseURL: process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`,
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    const res = await ctx.post('/api/test/seed', {
      data: {
        email,
        userName: FIXTURE_USER_NAME,
        vehicleName: FIXTURE_VEHICLE_NAME,
        tripName: FIXTURE_TRIP_NAME,
        forcedFuelStop: true,
      },
    });
    if (!res.ok()) throw new Error(`[e2e/existing-trip] seed failed (${res.status()}): ${await res.text()}`);
  } finally {
    await ctx.dispose();
  }
}

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

  test('a fuel stop Finn forced says why', async ({ page }) => {
    const email = uniqueEmail();
    await seedWithForcedFuelStop(email);
    await login(page, email);
    await openTrip(page);

    const firstDay = page.getByTestId('leg-card').first();
    await expect(firstDay).toBeVisible({ timeout: 15_000 });
    await firstDay.click();

    // CLAUDE.md: a forced stop MUST carry a one-line reason — and the driver
    // has to be able to read it, which until 2026-09-24 nothing rendered.
    const row = page.getByTestId('stop-row').filter({ hasText: 'TotalEnergies Château-Thierry' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/^Top up here:/)).toHaveText("Top up here: next fuel is 412 km away, on the next day's drive");
    // Only the forced stop carries a line; the destination row does not.
    await expect(page.getByTestId('stop-row').filter({ hasText: 'Top up here' })).toHaveCount(1);
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

/**
 * The trips list's date headers (nocturne-reskin §7a, superseded 2026-09-22):
 * the start date sits in a header above each run of trips sharing it, not in
 * the card, and the list reads newest date first.
 *
 * The fixtures are created OUT of date order on purpose — the sooner trip last —
 * so that ordering by last activity (what the list used to do) puts it first
 * and fails the order assertion, rather than passing by coincidence.
 */
test.describe('Trips list date headers', () => {
  const DATE_HEADER = /^\d{2} [A-Z][a-z]{2} \d{4}$/;
  const ANY_DATE = /\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]{2} \d{4}/;

  test('headers carry the date, cards do not, one header per shared day, newest first', async ({
    page,
  }) => {
    // Relative to today, never literal (seedDates.test.ts): both well past the
    // seeded trip's near-future start, a year apart.
    const later = legDateISO(todayISO(), 800);
    const sooner = legDateISO(todayISO(), 400);
    const laterLabel = formatDayMonthYear(later)!;
    const soonerLabel = formatDayMonthYear(sooner)!;

    const email = await signInAsNewUser(page);
    const a = await createBlankPlanningTrip(email, 'dates-a', later);
    const b = await createBlankPlanningTrip(email, 'dates-b', later);
    const c = await createBlankPlanningTrip(email, 'dates-c', sooner);
    await page.goto('/trips');

    const headers = page.getByTestId('trip-date-header');
    // Three dated runs: `later` (a, b), `sooner` (c), and the seeded trip's.
    await expect(headers).toHaveCount(3);
    const labels = (await headers.allInnerTexts()).map((s) => s.trim());
    for (const label of labels) expect(label).toMatch(DATE_HEADER);
    expect(labels.slice(0, 2)).toEqual([laterLabel, soonerLabel]);

    // Two trips sharing a start date sit under ONE header.
    expect(labels.filter((l) => l === laterLabel)).toHaveLength(1);
    const shared = page.getByTestId('trip-date-group').filter({ has: page.getByText(laterLabel, { exact: true }) });
    await expect(shared.getByTestId('trip-card')).toHaveCount(2);
    await expect(shared.locator(`[data-trip-name="${a.name}"]`)).toHaveCount(1);
    await expect(shared.locator(`[data-trip-name="${b.name}"]`)).toHaveCount(1);

    // Descending date order, header by header and card by card.
    const times = labels.map((l) => Date.parse(`${l} UTC`));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const names = await page.getByTestId('trip-card').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-trip-name')),
    );
    expect(names.indexOf(c.name)).toBeGreaterThan(Math.max(names.indexOf(a.name), names.indexOf(b.name)));

    // No date inside any card. The seeded trip has legs, so it has a meta line.
    const metas = await page.getByTestId('trip-card-meta').allInnerTexts();
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) expect(meta).not.toMatch(ANY_DATE);
    await expect(page.getByTestId('trip-card-meta').first()).toContainText('2 days');
  });
});
