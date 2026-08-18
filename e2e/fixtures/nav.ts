import { expect, type Page } from '@playwright/test';
import { FIXTURE_TRIP_NAME } from './constants';

/**
 * Open a trip from /trips by name.
 *
 * Clicks the anchor itself. TripCard renders a real `<a href="/trips/<id>">`
 * (a Next `<Link>`), so this navigates without any JavaScript at all — which
 * matters, because /trips currently loses clicks made during hydration.
 *
 * Retried for that reason: React 18 defers discrete events on a tree it hasn't
 * hydrated yet, and when hydration then CRASHES (this app throws #418/#423 on
 * every route) the queued click is discarded along with the server tree. The
 * anchor's default was prevented and the replay never came, so the click is
 * simply swallowed. Clicking again after the client-rendered root settles works.
 *
 * Delete the retry once hydration is fixed — but not before.
 */
export async function openTrip(page: Page, tripName: string = FIXTURE_TRIP_NAME): Promise<void> {
  const card = page.locator(`[data-testid="trip-card"][data-trip-name="${tripName}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  const link = card.getByRole('link').first();
  await expect(async () => {
    await link.click();
    // Short per-attempt wait: a swallowed click never navigates at all, so
    // waiting 30s on the first one just burns the budget. Cold lambdas + a
    // Neon branch waking up are covered by the overall toPass timeout.
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/, { timeout: 10_000 });
  }).toPass({ timeout: 45_000, intervals: [500, 1000, 2000] });
}
