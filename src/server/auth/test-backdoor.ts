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
