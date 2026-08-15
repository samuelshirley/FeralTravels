import { test, expect } from '@playwright/test';
import { createFreshUser, readOtpCode } from './fixtures/auth';

/**
 * The one spec that would prove the EMAIL half of sign-in: that Resend
 * delivers, and that the template contains a code a human could read.
 *
 * It is skipped, and that is a deliberate, visible hole rather than an
 * oversight. The suite reads OTPs from /api/test/otp (see fixtures/auth.ts),
 * and fixture addresses are never transmitted at all, so nothing here can
 * observe a real send. Restoring it needs an inbound mail path we own —
 * Resend supports receiving on a subdomain via its API, which is the intended
 * fix.
 *
 * E2E_MAX_SKIPPED=1 in .github/workflows/ci.yml exists for exactly this spec.
 * If a second one starts skipping, CI goes red instead of quietly testing
 * less — which is the failure mode that let a mass-skipping suite ship green
 * for two weeks in August.
 *
 * The rest of the flow below (form → verify UI → session) IS covered, by every
 * other spec, through the same real screens.
 */
test.describe('Email OTP login — real delivery', () => {
  test.skip(
    true,
    'No inbound mail path: fixture addresses are never sent to. Restore with Resend inbound on a subdomain.'
  );

  test('round-trip: real emailed code → land on /trips', async ({ page }) => {
    test.setTimeout(120_000);
    const user = createFreshUser();

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(user.email);
    await Promise.all([
      page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
      page.getByRole('button', { name: /email me a code/i }).click(),
    ]);
    await expect(page.locator('text=/6-digit code/i')).toBeVisible();

    const code = await readOtpCode(page, user.email);
    expect(code).toMatch(/^\d{6}$/);

    const firstDigit = page
      .locator('input[aria-label="Digit 1 of 6"]')
      .or(page.locator('input[autocomplete="one-time-code"]'))
      .first();
    await firstDigit.click();
    await Promise.all([
      page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 }),
      page.keyboard.type(code),
    ]);

    await expect(page).toHaveURL(/\/trips/);
    await expect(page.locator('h1')).toHaveText(/Trips/i);
  });
});
