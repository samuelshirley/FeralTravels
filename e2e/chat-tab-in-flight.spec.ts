import { test, expect } from '@playwright/test';
import { signInAsNewUser } from './fixtures/auth';
import { openTrip } from './fixtures/nav';
import { finishSeededTurn, seedRunningTurn } from './fixtures/test-trip';

/**
 * The exact path from the bug report, walked end to end.
 *
 * ── The report, and what the repro found ──────────────────────────────────
 *
 * Reported on iOS, 2026-09-11: with Penny still generating, tapping SETTINGS
 * and then CHAT landed on the trips LIST rather than the chat; tapping back
 * into the trip and then CHAT showed no thinking indicator and a header pill
 * reading READY, with a turn still in flight.
 *
 * Both reproduced on a simulator. The measurement for the second one:
 *
 *     12:51:48  penny_turns.status = running
 *     12:51:49  screenshot: header pill reads READY
 *     12:52:10  live view hierarchy: one text node 'READY', no 'THINKING'
 *     12:52:11  penny_turns.status = running
 *
 * ── Why the turn is planted rather than run ───────────────────────────────
 *
 * Producing that state honestly means asking Penny to plan something and
 * racing her: an Anthropic call on every push (the `ai-tests` label exists
 * because this suite must not do that), 60-90 seconds of wall clock, and a
 * race the suite would start losing the day she got faster. `seedRunningTurn`
 * writes the row the server would have written. Everything the CLIENT does is
 * real — it reads the real turns endpoint and decides for itself what to
 * render, which is the decision that was wrong.
 *
 * ── Why a phone viewport ──────────────────────────────────────────────────
 *
 * The bottom nav only exists below the mobile breakpoint. On a desktop layout
 * chat is permanently on screen, so neither bug can happen there.
 */
test.use({ viewport: { width: 390, height: 844 } });

test.describe('leaving a trip mid-turn and coming back', () => {
  test('CHAT returns to the open chat, still showing Penny at work', async ({ page }) => {
    const email = await signInAsNewUser(page);
    await openTrip(page);
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/);
    const tripId = page.url().match(/\/trips\/([0-9a-f-]{36})/)![1];

    // The server is now mid-answer for this trip.
    const turnKey = await seedRunningTurn(email, tripId);

    try {
      // ── the driver is in the chat, and Penny is working ──────────────────
      await page.goto(`/trips/${tripId}?tab=chat`);
      const pill = page.getByTestId('penny-status');
      await expect(pill).toHaveText(/THINKING/, { timeout: 20_000 });

      // ── step 2 of the report: SETTINGS, then CHAT ────────────────────────
      await page.getByRole('link', { name: 'Settings' }).click();
      await page.waitForURL(/\/settings/);

      await page.getByRole('link', { name: 'Chat' }).click();

      /*
       * The first bug. This used to land on `/trips` — the index — because the
       * nav sent every trip tab there when it had no trip in scope. It must
       * come back to the conversation the driver left.
       */
      await expect(page).toHaveURL(new RegExp(`/trips/${tripId}\\?tab=chat`), {
        timeout: 20_000,
      });

      /*
       * The second bug, on the mount that comes back. This is a genuinely
       * fresh mount — a full document navigation — so nothing in memory could
       * carry the answer across; it has to ask the server.
       */
      await expect(page.getByTestId('penny-status')).toHaveText(/THINKING/, {
        timeout: 20_000,
      });
      await expect(page.getByTestId('penny-status')).not.toHaveText(/READY/);

      // And the transcript agrees with the header.
      await expect(page.getByLabel('Penny is typing')).toBeVisible();
    } finally {
      await finishSeededTurn(email, turnKey);
    }
  });

  /**
   * The other direction, so this is not just asserting "always say THINKING":
   * with nothing running, the same fresh mount reads READY.
   */
  test('a trip with no turn running reads READY', async ({ page }) => {
    await signInAsNewUser(page);
    await openTrip(page);
    await page.waitForURL(/\/trips\/[0-9a-f-]{36}/);
    const tripId = page.url().match(/\/trips\/([0-9a-f-]{36})/)![1];

    await page.goto(`/trips/${tripId}?tab=chat`);
    await expect(page.getByTestId('penny-status')).toHaveText(/READY/, { timeout: 20_000 });
    await expect(page.getByLabel('Penny is typing')).toHaveCount(0);
  });

  /**
   * The fallback the fix must not lose: a session that has never opened a trip
   * has no chat to be returned to, and CHAT still has to reach the index.
   */
  test('with no trip ever opened, CHAT still goes to the trips list', async ({ page }) => {
    await signInAsNewUser(page);
    await page.goto('/settings');
    await page.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/trips$/, { timeout: 20_000 });
  });
});
