import { test, type Page } from '@playwright/test';
import {
  MAILBOX_CONFIGURED,
  SKIP_NO_MAILBOX,
  taggedAddress,
  waitForOtpCode,
} from './mailbox';

/**
 * E2E authentication — the REAL sign-in path, no bypass.
 *
 * Every test signs in as a FRESH user: mint a unique plus-addressed variant of
 * the test mailbox, submit it on /login, wait for the actual OTP email the app
 * sends (via Resend), read the 6-digit code out of it over IMAP, and type it
 * on /login/verify. `signInWithOtp` find-or-creates the user, so seeding
 * fixture data for the same email (over `/api/test/seed`) before OR after
 * login both work.
 *
 * Requirements: `E2E_IMAP_USER` + `E2E_IMAP_PASSWORD` (specs skip without
 * them) and a working Resend key on the target app so OTP emails actually
 * send. See `mailbox.ts` for the Gmail app-password setup.
 *
 * Unlike the MailSlurp era this SKIPS only when the mailbox isn't configured.
 * A mailbox that is configured but not working is a genuine failure and reds
 * the spec — there's no third party left whose outage we're absorbing, and CI
 * preflights the credentials before the suite runs anyway.
 */

export { MAILBOX_CONFIGURED, SKIP_NO_MAILBOX };

export interface FreshUser {
  email: string;
  tag: string;
  /** When this user was minted — bounds the mailbox search. */
  since: Date;
}

let seq = 0;

/**
 * Mint a fresh user address. No network call, so unlike the old
 * `createFreshUser()` this can't fail or skip — there is no inbox to
 * provision, just an address the mailbox already accepts.
 */
export function createFreshUser(): FreshUser {
  const runId = process.env.GITHUB_RUN_ID || `local${process.pid}`;
  const tag = `${runId}-${Date.now().toString(36)}-${seq++}`;
  return {
    email: taggedAddress(tag),
    tag,
    // Back-date slightly so clock skew between the runner and the mail server
    // can't put the email just outside the search window.
    since: new Date(Date.now() - 60_000),
  };
}

/**
 * Drive the real OTP UI flow for `user` and land on `redirectTo`.
 * Mirrors login-otp.spec.ts, which remains the focused test of this flow.
 */
export async function loginViaOtp(
  page: Page,
  user: FreshUser,
  opts: { redirectTo?: string } = {}
): Promise<void> {
  const redirectTo = opts.redirectTo || '/trips';

  await page.goto(`/login?callbackUrl=${encodeURIComponent(redirectTo)}`);
  await page.locator('input[name="email"]').fill(user.email);
  await Promise.all([
    page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
    page.getByRole('button', { name: /email me a code/i }).click(),
  ]);

  const code = await waitForOtpCode(user.email, { since: user.since });

  const firstDigit = page
    .locator('input[aria-label="Digit 1 of 6"]')
    .or(page.locator('input[autocomplete="one-time-code"]'))
    .first();
  await firstDigit.click();
  // Six single-char boxes that auto-advance on keystroke — fill() would dump
  // all six digits into box 1 (→ InvalidCode). Type real keystrokes instead.
  const target = redirectTo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await Promise.all([
    page.waitForURL(new RegExp(`${target}(\\?|$)`), { timeout: 30_000 }),
    page.keyboard.type(code),
  ]);
}

/**
 * One-call setup used by most specs: fresh user + real OTP login.
 * Seed fixture data for `user.email` before or after as the spec needs.
 */
export async function loginAsFreshUser(
  page: Page,
  opts: { redirectTo?: string } = {}
): Promise<FreshUser> {
  const user = createFreshUser();
  await loginViaOtp(page, user, opts);
  return user;
}

/** Kept so specs can guard consistently. */
export function skipUnlessMailbox(): void {
  test.skip(!MAILBOX_CONFIGURED, SKIP_NO_MAILBOX);
}
