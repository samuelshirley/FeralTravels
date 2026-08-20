import { NextResponse, type NextRequest } from 'next/server';

// Edge-safe cookie-only session check. Real auth happens in server pages /
// API routes via `auth()` (which talks to Postgres on the Node runtime).
// In production Auth.js prefixes the cookie with `__Secure-`.
const SESSION_COOKIE_NAMES = ['authjs.session-token', '__Secure-authjs.session-token'];

const PUBLIC_PREFIXES = [
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
];

export default function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
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
