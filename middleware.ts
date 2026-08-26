import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/paywallPaths';

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
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('callbackUrl', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
