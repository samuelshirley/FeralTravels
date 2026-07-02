import 'server-only';

/**
 * Guard for the E2E fixture endpoints (`/api/test/seed|trip|cleanup|announcement`).
 *
 * These endpoints manipulate FIXTURE DATA only (create/reset/delete test rows).
 * There is deliberately NO session-minting or sign-in bypass anywhere — the
 * only way to authenticate is the real Google OAuth or the real emailed OTP
 * code (E2E reads it via MailSlurp).
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
