import 'server-only';
import { cookies } from 'next/headers';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users, sessions } from '@/server/db/schema';
import { isAuthTestBackdoorConfigured } from './test-backdoor';

/**
 * TEST-ONLY session minting for the E2E suite.
 *
 * This mirrors the session + cookie mechanism of the real OTP sign-in
 * (`signInWithOtp` in ./otp.ts) EXACTLY, minus the OTP code check — it inserts
 * a database `sessions` row and writes the Auth.js session cookie so `auth()`
 * treats the caller as signed in. It exists so the E2E suite can authenticate
 * over HTTP (against an ephemeral preview) instead of reaching into the
 * database directly.
 *
 * SECURITY: hard-gated by `isAuthTestBackdoorConfigured()`, the same guard as
 * the existing test backdoor. That returns false on real Vercel production
 * (`VERCEL_ENV=production`) unless `AUTH_TEST_BACKDOOR_ON_VERCEL_PROD=1`, so
 * this is inert in prod. The API route that calls it enforces the same guard.
 */

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (mirrors otp.ts)

// Cookie-name logic copied from otp.ts (not exported there). Keep in sync.
function useSecureSessionCookies(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  const raw = process.env.AUTH_URL || process.env.NEXTAUTH_URL || '';
  if (!raw.trim()) return true;
  const siteUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  try {
    return new URL(siteUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

function getSessionCookieName(): string {
  return useSecureSessionCookies()
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/**
 * Find-or-create the user for `email`, mint a database session, and set the
 * session cookie on the response. Returns the user id.
 */
export async function createTestSession(email: string): Promise<{ userId: string }> {
  if (!isAuthTestBackdoorConfigured()) {
    throw new Error('test session endpoint is disabled');
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('email required');

  const existing = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);

  let userId: string;
  if (existing.length > 0) {
    userId = existing[0].id;
    if (!existing[0].emailVerified) {
      await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, userId));
    }
  } else {
    const [row] = await db
      .insert(users)
      .values({ email: normalized, emailVerified: new Date() })
      .returning({ id: users.id });
    userId = row.id;
  }

  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await db.insert(sessions).values({ sessionToken, userId, expires });

  const cookieStore = await cookies();
  cookieStore.set(getSessionCookieName(), sessionToken, {
    httpOnly: true,
    secure: useSecureSessionCookies(),
    sameSite: 'lax',
    path: '/',
    expires,
  });

  return { userId };
}
