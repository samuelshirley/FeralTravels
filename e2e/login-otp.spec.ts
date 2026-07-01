import { test, expect } from '@playwright/test';
import { MailSlurp } from 'mailslurp-client';

/**
 * Real OTP end-to-end via MailSlurp. Creates a disposable inbox, submits its
 * address on /login, waits for the ACTUAL OTP email the app sends (via Resend),
 * extracts the 6-digit code, enters it, and lands on /trips.
 *
 * This deliberately exercises the real path — generate → email → verify — with
 * no bypass, so a broken OTP flow fails here instead of passing silently.
 * `signInWithOtp` find-or-creates the user, so no pre-seed is needed.
 *
 * Gated on MAILSLURP_API_KEY; auto-skips without it so a fresh checkout passes.
 */
const MAILSLURP_API_KEY = process.env.MAILSLURP_API_KEY;

test.describe('Email OTP login (MailSlurp)', () => {
  test.skip(!MAILSLURP_API_KEY, 'MAILSLURP_API_KEY not set — real OTP e2e skipped');

  test('round-trip: real emailed code → land on /trips', async ({ page }) => {
    test.setTimeout(90_000);
    const mailslurp = new MailSlurp({ apiKey: MAILSLURP_API_KEY! });
    const inbox = await mailslurp.createInbox();

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(inbox.emailAddress);
    await Promise.all([
      page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
      page.getByRole('button', { name: /email me a code/i }).click(),
    ]);
    await expect(page.locator('text=/6-digit code/i')).toBeVisible();

    // Wait for the real OTP email, then pull the 6-digit code out of it.
    const email = await mailslurp.waitForLatestEmail(inbox.id, 60_000, true);
    const match = (email.body || '').match(/\b(\d{6})\b/);
    expect(match, 'OTP email did not contain a 6-digit code').not.toBeNull();
    const code = match![1];

    const firstDigit = page
      .locator('input[aria-label="Digit 1 of 6"]')
      .or(page.locator('input[autocomplete="one-time-code"]'))
      .first();
    await firstDigit.click();
    await Promise.all([
      page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 }),
      firstDigit.fill(code),
    ]);

    await expect(page).toHaveURL(/\/trips/);
    await expect(page.locator('h1')).toHaveText(/Trips/i);
  });
});
