import { test, type Page } from '@playwright/test';
import { MailSlurp } from 'mailslurp-client';

/**
 * E2E authentication — the REAL sign-in path, no bypass.
 *
 * Every test signs in as a FRESH MailSlurp user: create a disposable inbox,
 * submit its address on /login, wait for the actual OTP email the app sends
 * (via Resend), extract the 6-digit code, and type it on /login/verify.
 * `signInWithOtp` find-or-creates the user, so seeding fixture data for the
 * same email (over `/api/test/seed`) before OR after login both work.
 *
 * Requirements: `MAILSLURP_API_KEY` (specs skip without it) and a working
 * Resend key on the target app so OTP emails actually send.
 *
 * MailSlurp's free tier can rate-limit or auto-disable inbox creation; when
 * it's unavailable we SKIP rather than fail — a third-party outage shouldn't
 * red the whole pipeline. (Trade-off: a MailSlurp outage means most of the
 * suite skips. Watch the run summary for mass-skips before promoting.)
 */

export const MAILSLURP_API_KEY = process.env.MAILSLURP_API_KEY;

export const SKIP_NO_MAILSLURP =
  'MAILSLURP_API_KEY not set — real-OTP sign-in unavailable, spec skipped';

/**
 * Turn whatever MailSlurp threw into something a CI log can act on.
 *
 * `String(err)` gave us "[object Object]" for eleven straight skipped specs —
 * mailslurp-client rejects with a response-shaped object, not an Error, so
 * neither `err.message` nor `String(err)` says anything. The HTTP status is
 * the whole diagnosis here: 401 means the key is wrong or revoked, 402/403
 * means the plan or account won't allow it, 429 means rate limited. Without
 * it you cannot tell "I pasted the key wrong" from "they blocked me again".
 */
export async function describeMailSlurpError(err: unknown): Promise<string> {
  if (!err || typeof err !== 'object') return String(err);

  const e = err as {
    message?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusText?: string; text?: () => Promise<string> };
  };
  const res = e.response;
  const status = res?.status ?? e.status ?? e.statusCode;

  let body = '';
  if (res && typeof res.text === 'function') {
    // Best-effort: the body may already have been consumed by the client.
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
  }

  const parts = [
    status != null ? `HTTP ${status}${res?.statusText ? ` ${res.statusText}` : ''}` : '',
    e.message ?? '',
    body,
  ].filter(Boolean);

  if (parts.length) return parts.join(' — ');
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return String(err); // circular
  }
}

export interface FreshUser {
  email: string;
  inboxId: string;
}

let client: MailSlurp | null = null;
function mailslurp(): MailSlurp {
  if (!MAILSLURP_API_KEY) throw new Error(SKIP_NO_MAILSLURP);
  if (!client) client = new MailSlurp({ apiKey: MAILSLURP_API_KEY });
  return client;
}

/**
 * Create a fresh disposable user (MailSlurp inbox). Call inside a test or
 * beforeEach — on MailSlurp outage it marks the test skipped instead of red.
 */
export async function createFreshUser(): Promise<FreshUser> {
  try {
    const inbox = await mailslurp().createInbox();
    return { email: inbox.emailAddress, inboxId: inbox.id };
  } catch (err) {
    test.skip(true, `MailSlurp unavailable — skipping (${await describeMailSlurpError(err)})`);
    throw err; // unreachable (test.skip aborts); satisfies the type checker
  }
}

/** Extract the 6-digit code from the OTP email. Subject first ("123456 is
 * your Feral Travels sign-in code") — the HTML body's inline CSS contains
 * numeric hex colors (#333333) that a bare \d{6} matches first, and the
 * displayed code is split "123 456". Falls back to the hidden origin-bound
 * "#<code>" line in the body (WICG one-time-code format). */
function extractOtpCode(subject: string | undefined, body: string | undefined): string | null {
  const match = (subject || '').match(/\b(\d{6})\b/) || (body || '').match(/#(\d{6})\b/);
  return match ? match[1] : null;
}

/**
 * Drive the real OTP UI flow for `user` and land on `redirectTo`.
 * Mirrors login-otp.spec.ts, which remains the focused test of this flow.
 */
export async function loginViaOtp(
  page: Page,
  user: FreshUser,
  opts: { redirectTo?: string } = {},
): Promise<void> {
  const redirectTo = opts.redirectTo || '/trips';

  await page.goto(`/login?callbackUrl=${encodeURIComponent(redirectTo)}`);
  await page.locator('input[name="email"]').fill(user.email);
  await Promise.all([
    page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
    page.getByRole('button', { name: /email me a code/i }).click(),
  ]);

  const email = await mailslurp().waitForLatestEmail(user.inboxId, 60_000, true);
  const code = extractOtpCode(email.subject ?? undefined, email.body ?? undefined);
  if (!code) throw new Error('[e2e/auth] OTP email did not contain a 6-digit code');

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
  opts: { redirectTo?: string } = {},
): Promise<FreshUser> {
  const user = await createFreshUser();
  await loginViaOtp(page, user, opts);
  return user;
}
