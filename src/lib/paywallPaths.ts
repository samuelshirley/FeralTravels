/**
 * The two allowlists that decide what a gate may refuse.
 *
 * They answer DIFFERENT questions and must not be merged:
 *
 * - `PUBLIC_PATH_PREFIXES` — reachable with no session at all. This is the
 *   list `middleware.ts` has always enforced; it lives here so the paywall
 *   cannot be written against a second, quietly-diverging copy of it.
 * - `PAYWALL_EXEMPT_PREFIXES` — reachable by a signed-in user who is NOT
 *   entitled. Everything public is also paywall-exempt (a stranger gets these
 *   pages, so a customer whose card expired certainly does), plus the paths a
 *   blocked user must keep: settings, account deletion, sign-out.
 *
 * Deliberately a plain module — no `server-only`, no DB import — because
 * `middleware.ts` runs on the edge and the unit tests import it directly.
 *
 * MATCHING IS BY EXPLICIT PREFIX, never by ordering or by "everything under
 * /trips is fine". `/privacy`, `/terms` and `/support` were unreachable signed
 * out once already (fixed in PR #7, guarded by `e2e/legal-pages.spec.ts`), and
 * a site-wide paywall is the single easiest way to regress it. If a new gate
 * needs an exception, add the prefix here where the test can see it.
 */

export const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/api/auth',
  // Native sign-in: requesting/redeeming a code IS the start of sign-in, so
  // these must be reachable without a session cookie. Not public-by-accident:
  // both routes are Zod-validated and rate-limited.
  '/api/mobile/otp',
  // Same reasoning for the native OAuth exchange — a request that trades a
  // Google/Apple ID token for a session has no session yet by definition.
  // Without this the route 302s to /login and every "Continue with Google"
  // tap dies on an HTML response, with nothing in the error copy to explain
  // it. NOTE: unlike the OTP routes this one is NOT rate-limited yet.
  '/api/mobile/oauth',
  // The store calls this one with no session and never will have one. It
  // authenticates itself with a signature, not a cookie.
  '/api/webhooks/',
  // The legal pages are fetched ANONYMOUSLY by Google brand verification and
  // Apple App Review. src/app/(legal)/layout.tsx calls them "deliberately
  // public", but that only governs the layout — middleware runs first, so
  // without these entries a reviewer sees a sign-in wall on the exact URLs
  // submitted to the consent screen and to App Store Connect.
  '/privacy',
  '/terms',
  '/support',
  // Anything a legal page LOADS has to be public too, not just the page.
  // Next runs middleware for files in public/ as well — that is why
  // /favicon.ico, /manifest.json, /icon- and /sw.js are all listed
  // individually below. An <img> that 302s to /login renders as a broken
  // image to the reviewer fetching the page. One prefix instead of one entry
  // per file: put assets referenced by these pages in public/legal/.
  '/legal/',
  '/_next',
  '/favicon.ico',
  '/manifest.json',
  '/icon-',
  '/sw.js',
] as const;

/**
 * Paths a signed-in but unentitled user keeps.
 *
 * Account deletion is on this list because Apple guideline 5.1.1(v) requires
 * it reachable in-app — a paywall in front of "delete my account" is a
 * rejection, and a fairly deserved one. Settings is here for the same family
 * of reasons: someone who cannot pay must still be able to leave tidily.
 *
 * Viewing an existing itinerary costs nothing (no Anthropic call happens), so
 * `/trips` is NOT blanket-blocked here — the trips surfaces decide per-verdict
 * whether the read is still allowed, because `refunded` and `revoked` close
 * that door and no other state does.
 */
export const PAYWALL_EXEMPT_PREFIXES = [
  ...PUBLIC_PATH_PREFIXES,
  '/settings',
  '/api/me',
  '/api/support',
  '/api/analytics',
] as const;

function matches(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((p) => pathname.startsWith(p));
}

/** Reachable with no session. */
export function isPublicPath(pathname: string): boolean {
  return matches(PUBLIC_PATH_PREFIXES, pathname);
}

/** Reachable by a signed-in user the paywall would otherwise refuse. */
export function isPaywallExempt(pathname: string): boolean {
  return matches(PAYWALL_EXEMPT_PREFIXES, pathname);
}
