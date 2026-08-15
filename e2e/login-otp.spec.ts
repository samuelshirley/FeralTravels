import { test, expect } from '@playwright/test';
import { MAILBOX_CONFIGURED, SKIP_NO_MAILBOX, createFreshUser } from './fixtures/auth';
import { waitForOtpCode } from './fixtures/mailbox';

/**
 * Real OTP end-to-end. Mints a unique plus-addressed user, submits it on
 * /login, waits for the ACTUAL email the app sends (via Resend) to arrive in
 * the test mailbox, reads the 6-digit code over IMAP, enters it, lands on
 * /trips.
 *
 * This is the ONE spec that proves the whole email path — generation, Resend
 * delivery, and the template actually containing a parseable code. The other
 * specs use the same machinery to sign in, but this one is the reason the
 * machinery reads real mail rather than shortcutting to the database: a change
 * to the email template that breaks the code should fail here.
 *
 * Gated on the mailbox being configured; auto-skips without it so a fresh
 * checkout passes.
 */
test.describe('Email OTP login (real mailbox)', () => {
  test.skip(!MAILBOX_CONFIGURED, SKIP_NO_MAILBOX);

  test('round-trip: real emailed code → land on /trips', async ({ page }) => {
    test.setTimeout(120_000);

    // No inbox to provision — plus-addressing means the mailbox already
    // accepts this address. Nothing here can fail or skip.
    const user = createFreshUser();

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(user.email);
    await Promise.all([
      page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
      page.getByRole('button', { name: /email me a code/i }).click(),
    ]);
    await expect(page.locator('text=/6-digit code/i')).toBeVisible();

    // Real delivery, so this is the slow part. waitForOtpCode parses the
    // SUBJECT ("123456 is your Feral Travels sign-in code") rather than the
    // HTML body — the body's inline CSS hex colours (#333333) match a bare
    // \d{6} first, and the displayed code is split "123 456" so it never
    // matches. See extractOtpCode in fixtures/mailbox.ts.
    const code = await waitForOtpCode(user.email, { since: user.since });
    expect(code, 'OTP email did not contain a 6-digit code').toMatch(/^\d{6}$/);

    const firstDigit = page
      .locator('input[aria-label="Digit 1 of 6"]')
      .or(page.locator('input[autocomplete="one-time-code"]'))
      .first();
    await firstDigit.click();
    // The verify UI is six single-char boxes that auto-advance on keystroke, so
    // fill() would dump all six digits into box 1 (→ InvalidCode). Type the code
    // as real keystrokes so each digit lands in its own box.
    await Promise.all([
      page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 }),
      page.keyboard.type(code),
    ]);

    await expect(page).toHaveURL(/\/trips/);
    await expect(page.locator('h1')).toHaveText(/Trips/i);
  });
});
