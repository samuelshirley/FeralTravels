import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/paywallPaths';
import { GET_THE_APP_PATH, isBlockedWebPath, webAppEnabled } from '@/lib/webAccess';

// Edge-safe cookie-only session check. Real auth happens in server pages /
// API routes via `auth()` (which talks to Postgres on the Node runtime).
// In production Auth.js prefixes the cookie with `__Secure-`.
const SESSION_COOKIE_NAMES = ['authjs.session-token', '__Secure-authjs.session-token'];

/**
 * The public allowlist moved to `src/lib/paywallPaths.ts` — it is now shared
 * with the subscription gate, which needs exactly the same set of exceptions
 * and must not be written against a second copy that drifts.
 *
 * THE PAYWALL IS NOT ENFORCED HERE, and cannot be: entitlement is a database
 * question and this runs on the edge with no DB. It is enforced in the server
 * components and API routes that spend money. That split matters for the one
 * regression everybody is afraid of — a site-wide wall in front of /privacy,
 * /terms and /support (see `e2e/legal-pages.spec.ts`). Anything added to this
 * file runs in front of EVERY path, so if a gate ever does land here, it goes
 * BELOW the `isPublicPath` check, never above it.
 */
export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const hasSession = SESSION_COOKIE_NAMES.some((name) => req.cookies.get(name)?.value);

  /**
   * The web app is off (2026-08-28, iOS-first). A browser with no session gets
   * the download screen instead of a sign-in form.
   *
   * BELOW `isPublicPath`, never above it — the comment at the top of this file
   * says any gate landing here goes below, and this is the gate it was written
   * about. `/privacy`, `/terms` and `/support` are typed into App Store Connect
   * and the Google consent screen, and a reviewer who gets a download prompt
   * instead of a privacy policy files a rejection.
   *
   * `isBlockedWebPath` returns false for everything under `/api`, which is what
   * keeps the iOS app alive: it is nothing but calls to those routes, and it
   * authenticates with `Authorization: Bearer`, which nothing at the edge can
   * see. Verified against production before this shipped — `/api/trips`
   * unauthenticated answers 401 from its own guard, and must keep doing so.
   *
   * A request that DOES carry a session cookie is let through to the page,
   * where `requireWebAccess()` asks the database whether it belongs to the
   * admin. The edge cannot answer that question; it can only see that somebody
   * holds a cookie.
   */
  if (!webAppEnabled() && !hasSession && isBlockedWebPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = GET_THE_APP_PATH;
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('callbackUrl', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
