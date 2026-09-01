/**
 * The web app's master switch. Pages ON unless `WEB_APP_ENABLED=0`.
 *
 * Read that sentence twice — it is the opposite of `PAYWALL_ENABLED`, and this
 * line said the opposite of the code until 2026-08-28. The wrong version cost a
 * real detour: it reads as "merging this blocks the web", which sent someone
 * looking for a way to split the block out of a shared PR when the actual lever
 * was one Vercel variable. The switch is inverted ON PURPOSE (see `webAppEnabled`
 * below); a doc comment that inverts it back is worse than no comment.
 *
 * 2026-08-28: the product is an iOS app. The web came first and most users will
 * never know it exists, so rather than maintain two front ends and test both,
 * the browser now serves one screen — download the app — to everybody except
 * the admin account.
 *
 * WHY A SWITCH AND NOT A DELETION. The web is still the entire server: every
 * screen in the iOS app is a call to `www.feraltravels.com/api/*`. "Turn off
 * the web app" means turn off the PAGES, and the difference between those two
 * sentences is the whole app going dark. It is also reversible in an env change
 * if a desktop companion turns out to be wanted, which is the same argument
 * `PAYWALL_ENABLED` makes for itself.
 *
 * Default ON, unlike the paywall, and deliberately so: the failure mode of a
 * missing env var should be the app that works, not a blank site.
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
  '/login',
  GET_THE_APP_PATH,
  '/_next',
  '/favicon.ico',
  '/manifest.json',
  '/icon-',
  '/sw.js',
] as const;

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
  if (WEB_ALWAYS_ALLOWED.some((p) => pathname.startsWith(p))) return false;
  return true;
}
