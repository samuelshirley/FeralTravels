import { test, expect, type Page } from '@playwright/test';
import { uniqueEmail, login } from './fixtures/auth';
import { FIXTURE_TRIP_NAME, FIXTURE_USER_NAME, FIXTURE_VEHICLE_NAME, testEndpointHeaders } from './fixtures/constants';
import { openTrip } from './fixtures/nav';
import { request } from '@playwright/test';

/**
 * An imperial user sees miles, and no kilometres anywhere.
 *
 * Until 2026-09-04 the product decision was the opposite — "km primary,
 * (mi) secondary, we've decided to teach metric" — and on top of it four
 * places rendered `${n} km` with no units machinery at all: the itinerary
 * headline, a segment total, the NEXT STOP row and every stop row in an open
 * day. The unit-level guard (`noHardcodedUnitsGuard.test.ts`) makes the
 * literals impossible; this is the screen-level claim, read from the DOM the
 * driver sees: flip the preference, open a trip, open a day, and there is no
 * `km` in the itinerary pane. The fixture range is set low so day 1 needs a
 * fuel stop, which is what puts the NEXT STOP row and a stop row on screen.
 */
const KM = /\b\d[\d,.]*\s*km\b/;
const MI = /\b\d[\d,.]*\s*mi\b/;

async function seedShortRange(email: string): Promise<void> {
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
        // Day 1 is 489 km; against 300 km Finn must place a stop.
        rangeKm: 300,
      },
    });
    if (!res.ok()) throw new Error(`[e2e/units] seed failed (${res.status()}): ${await res.text()}`);
  } finally {
    await ctx.dispose();
  }
}

async function itineraryText(page: Page): Promise<string> {
  return (await page.getByTestId('leg-card').first().locator('..').innerText()).replace(/\s+/g, ' ');
}

test.describe('Imperial units', () => {
  test('the trip screen, an open day and NEXT STOP render miles and never km', async ({ page }) => {
    const email = uniqueEmail();
    await seedShortRange(email);
    await login(page, email);

    // The preference the Settings toggle writes, set the same way it does.
    const res = await page.request.patch('/api/me/preferences', { data: { units_pref: 'imperial' } });
    expect(res.ok(), `preferences PATCH ${res.status()}`).toBe(true);

    await openTrip(page);
    const day = page.getByTestId('leg-card').first();
    await expect(day).toBeVisible({ timeout: 20_000 });

    // The current day sources its own fuel on load; wait for the NEXT STOP
    // row, which exists only once a stop has been placed.
    const nextStop = page.getByRole('link', { name: /in Google Maps/ }).filter({ hasText: 'NEXT STOP' });
    await expect(nextStop).toBeVisible({ timeout: 60_000 });
    await expect(nextStop).toHaveText(MI);
    await expect(nextStop).not.toHaveText(KM);

    // Open the day: the stop rows and the destination row.
    await day.click();
    const rows = page.getByTestId('stop-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const rowText = (await rows.allInnerTexts()).join(' ');
    expect(rowText).toMatch(MI);
    expect(rowText).not.toMatch(KM);

    // The whole pane — headline, cards, rows — carries no kilometres.
    const text = await itineraryText(page);
    expect(text).toMatch(MI);
    expect(text, text).not.toMatch(KM);
  });
});
