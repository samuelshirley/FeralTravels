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
