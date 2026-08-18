import 'server-only';

/**
 * Guard for the E2E fixture endpoints (`/api/test/seed|trip|cleanup|announcement`).
 *
 * These endpoints manipulate FIXTURE DATA only (create/reset/delete test rows).
 * There is deliberately NO session-minting or sign-in bypass anywhere — the
 * only way to authenticate is the real Google OAuth or the real OTP code.
 * Since 2026-08-15 the suite reads that code from `/api/test/otp` instead of
 * out of an inbox. That is a narrower thing than it sounds: the code is still
 * generated, stored and must be typed into the real verify UI, and the
 * endpoint refuses any address outside the fixture pattern below.
 *
 * Hard invariants (unit-enforced in test-endpoints.test.ts):
 * 1. On Vercel production (`VERCEL_ENV === 'production'`) this is ALWAYS off.
 *    There is no override env var — none will be honored, ever.
 * 2. Off unless `E2E_TEST_ENDPOINTS=1` is explicitly set (CI's tested preview
 *    and the Playwright-launched local webServer set it; `npm run dev` and any
 *    real deployment do not).
 * 3. When `E2E_TEST_ENDPOINTS_SECRET` is set (CI derives a per-run secret for
 *    the internet-reachable preview), callers must echo it in the
 *    `x-e2e-test-secret` header.
 */

type EnvLike = Record<string, string | undefined>;

export function areTestEndpointsEnabled(env: EnvLike = process.env): boolean {
  // Invariant 1: never on production. Checked FIRST, no override honored.
  if (env.VERCEL_ENV === 'production') return false;
  return env.E2E_TEST_ENDPOINTS === '1';
}

/** Authorize a request to a `/api/test/*` fixture endpoint. */
export function isTestRequestAuthorized(req: Request, env: EnvLike = process.env): boolean {
  if (!areTestEndpointsEnabled(env)) return false;
  const secret = env.E2E_TEST_ENDPOINTS_SECRET?.trim();
  if (!secret) return true;
  return req.headers.get('x-e2e-test-secret')?.trim() === secret;
}

/**
 * The ONLY address family whose OTP may be read back over HTTP.
 *
 * `playwright-<runid>-<n>@e2e.feraltravels.com`. Deliberately hardcoded rather
 * than configurable: a guard you can widen with an env var is not a guard. Even
 * with test endpoints enabled AND the per-run secret in hand, a caller cannot
 * ask for a real account's code — the shape of the address is the boundary.
 *
 * `e2e.` is a subdomain with no MX, so these addresses can never receive mail
 * and can never belong to a person.
 */
export const FIXTURE_EMAIL_PATTERN = /^playwright-[a-z0-9._-]+@e2e\.feraltravels\.com$/i;

export function isFixtureEmail(email: string): boolean {
  return FIXTURE_EMAIL_PATTERN.test(email.trim().toLowerCase());
}

/**
 * Whether the OTP for `email` may be handled as fixture traffic — read back
 * over HTTP, and not actually transmitted by Resend.
 *
 * BOTH conditions matter. On production `areTestEndpointsEnabled()` is false
 * with no override, so this is false there for every address, including ones
 * that match the pattern.
 */
export function isFixtureRecipient(email: string, env: EnvLike = process.env): boolean {
  return areTestEndpointsEnabled(env) && isFixtureEmail(email);
}
