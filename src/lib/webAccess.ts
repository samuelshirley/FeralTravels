/**
 * The web app's master switch. Pages ON unless `WEB_APP_ENABLED=0`.
 *
 * Exactly the string `'0'` turns the web off; unset, `'1'` or anything else
 * leaves it on. 2026-10-01: Sam re-enabled the desktop web so the people he
 * interviews can try it. It is on by DEFAULT so that merging is the release —
 * no Vercel variable to set — and `WEB_APP_ENABLED=0` in Vercel is the kill
 * switch.
 *
 * History, briefly. 2026-08-28 the browser was cut to one screen, download
 * the app, for everyone but the admin: the product is an iOS app and two front
 * ends meant testing both. On 2026-09-24 it turned out production had never
 * set the variable while the default was ON, so the web was open the whole
 * time it was meant to be off; the default became OFF until this re-enable.
 *
 * WHY A SWITCH AND NOT A DELETION. The web is still the entire server: every
 * screen in the iOS app is a call to `www.feraltravels.com/api/*`. "Turn off
 * the web app" means turn off the PAGES, and the difference between those two
 * sentences is the whole app going dark. The gate is `requireWebAccess()` in
 * each PAGE and never runs on `/api`, so the switch cannot take the iOS app
 * down in either position.
 *
 * The root `middleware.ts` does not run — with `src/app`, Next 14 looks for
 * middleware only in `src/` — so `requireWebAccess()` in each page is the
 * entire gate, and `webAccessCoverage.test.ts` is what keeps it on every page.
 */
type EnvLike = Record<string, string | undefined>;

export function webAppEnabled(env: EnvLike = process.env): boolean {
  return env.WEB_APP_ENABLED !== '0';
}

/** Where a blocked browser lands. */
export const GET_THE_APP_PATH = '/get-the-app';

/**
 * Paths that stay reachable in a browser even with the web app switched off.
 *
 * THIS LIST IS AN APP STORE SUBMISSION, not a convenience. Getting it wrong is
 * a rejection, and two of the entries have already been broken once (PR #7):
 *
 *   - `/privacy` and `/terms` are fetched ANONYMOUSLY by Apple App Review and
 *     by Google's brand verification for the OAuth consent screen. Those exact
 *     URLs are typed into App Store Connect and the Google Cloud console. A
 *     reviewer who gets a "download the app" screen instead of a privacy policy
 *     files a rejection, and the app is not going anywhere until it is fixed.
 *   - `/support` is the contact route a reviewer uses, and `/legal/` holds the
 *     image that page loads — Next runs middleware for files in `public/` too,
 *     so an <img> that 302s renders as a broken image to the reviewer.
 *   - `/login` has to work or the one person allowed in cannot get in.
 *
 * `/api/**` is NOT on this list because it is not gated at all — see
 * `isBlockedWebPath`. Every API route keeps its own auth guard; the iOS app
 * authenticates with `Authorization: Bearer`, never a cookie, and a gate that
 * touched `/api` would take the product down.
 */
export const WEB_ALWAYS_ALLOWED = [
  '/privacy',
  '/terms',
  '/support',
  '/legal/',
  // What the public landing page at `/` loads (see WEB_ALWAYS_ALLOWED_EXACT).
  '/landing/',
  '/login',
  GET_THE_APP_PATH,
  '/_next',
  '/favicon.ico',
  '/manifest.json',
  '/icon-',
  '/sw.js',
] as const;

/**
 * Paths allowed by EXACT match only, never as a prefix.
 *
 * `/` is the public landing page (2026-09-24): the App Store listing's own
 * URL, what a stranger, a crawler and a reviewer all land on. It cannot go in
 * the prefix list above — every path starts with `/`, so that one entry would
 * switch the whole gate off without a single test noticing a page it let in.
 *
 * The middleware that calls this is not compiled today (it sits beside `src/`,
 * not in it), so the in-page `requireWebAccess()` is the live gate. This is for
 * the day it is revived: without it, the landing page and its images would be
 * swapped for the download screen.
 */
export const WEB_ALWAYS_ALLOWED_EXACT = ['/'] as const;

/**
 * True for a browser PAGE that the download screen should replace.
 *
 * Everything under `/api` returns false — unconditionally, first, before any
 * other consideration. The iOS app is nothing but calls to those routes, so
 * this one line is the difference between disabling a web front end and
 * disabling the product.
 */
export function isBlockedWebPath(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname === '/api') return false;
  if (WEB_ALWAYS_ALLOWED_EXACT.some((p) => pathname === p)) return false;
  if (WEB_ALWAYS_ALLOWED.some((p) => pathname.startsWith(p))) return false;
  return true;
}
