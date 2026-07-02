import 'server-only';

/**
 * Temporary QA / agent sign-in bypass (email magic link without Resend).
 * Enable only via env; remove before real production launch.
 *
 * On Vercel production (`VERCEL_ENV=production`), also set
 * `AUTH_TEST_BACKDOOR_ON_VERCEL_PROD=1` or this stays off.
 */
export function isAuthTestBackdoorConfigured(): boolean {
  const on = process.env.AUTH_TEST_BACKDOOR === '1' || process.env.AUTH_TEST_BACKDOOR === 'true';
  if (!on) return false;
  const email = process.env.AUTH_TEST_BACKDOOR_EMAIL?.trim();
  if (!email) return false;
  if (process.env.VERCEL_ENV === 'production' && process.env.AUTH_TEST_BACKDOOR_ON_VERCEL_PROD !== '1') {
    return false;
  }
  return true;
}

export function authTestBackdoorEmailNormalized(): string | null {
  if (!isAuthTestBackdoorConfigured()) return null;
  return process.env.AUTH_TEST_BACKDOOR_EMAIL!.trim().toLowerCase();
}

export function authTestBackdoorRequiresToken(): boolean {
  const s = process.env.AUTH_TEST_BACKDOOR_SECRET?.trim();
  return !!s;
}

/**
 * Authorize a request to a `/api/test/*` endpoint.
 *
 * The backdoor must be configured, AND — when `AUTH_TEST_BACKDOOR_SECRET` is
 * set — the caller must echo it in the `x-test-backdoor-secret` header.
 *
 * The secret matters whenever the app under test is reachable beyond
 * localhost (the CI-tested Vercel preview): `/api/test/session` mints a real
 * session for an arbitrary email, so with no secret anyone holding the
 * preview URL could sign in as any user of the preview's DB branch. CI
 * generates a random per-run secret and passes it to both the deployed app
 * and the Playwright runner; local runs (no secret set) are unaffected.
 */
export function isTestRequestAuthorized(req: Request): boolean {
  if (!isAuthTestBackdoorConfigured()) return false;
  const secret = process.env.AUTH_TEST_BACKDOOR_SECRET?.trim();
  if (!secret) return true;
  return req.headers.get('x-test-backdoor-secret')?.trim() === secret;
}
