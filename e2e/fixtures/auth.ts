import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { FIXTURE_EMAIL } from './constants';
import { getDb, schema } from './db';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirrors src/server/auth/otp.ts

/**
 * Sign in as the seeded fixture user by creating a real Auth.js database
 * session row and dropping the cookie straight into the browser context.
 *
 * Why this instead of clicking the test-backdoor button:
 *   The app uses `session: { strategy: 'database' }`. Auth.js's
 *   Credentials provider — which is what the AUTH_TEST_BACKDOOR path
 *   wires through — silently doesn't support database sessions: the
 *   provider's `authorize()` returns the user OK, but Auth.js never
 *   creates a session row, so `auth()` on the next request finds
 *   nothing and bounces the user back to /login. The OTP path (the
 *   real production flow) sidesteps this by inserting into `sessions`
 *   itself and writing the cookie manually (see src/server/auth/otp.ts
 *   → signInWithOtp). We do the same here.
 *
 * The login UI for OTP entry is still tested by login-otp.spec.ts —
 * this helper is reserved for tests that need a session but aren't
 * themselves testing the login flow (vehicle CRUD, existing trip,
 * Penny submit, map render).
 */
export async function loginAsFixtureUser(page: Page, opts: { redirectTo?: string } = {}) {
  const redirectTo = opts.redirectTo || '/trips';

  const db = getDb();
  const userRow = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1)
  )[0];
  if (!userRow) {
    throw new Error(
      `[e2e/auth] Fixture user ${FIXTURE_EMAIL} not found. ` +
        'Did global setup run? Try `npm run e2e:seed`.',
    );
  }

  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await db.insert(schema.sessions).values({
    sessionToken,
    userId: userRow.id,
    expires,
  });

  // Dev cookie name: `authjs.session-token` (no __Secure- prefix because
  // the test webServer serves over HTTP). The cookie domain must match
  // the URL Playwright is hitting; we read it from the same env var the
  // playwright config uses.
  const baseURL =
    process.env.E2E_BASE_URL ||
    `http://localhost:${process.env.E2E_PORT || 4444}`;
  const url = new URL(baseURL);
  await page.context().addCookies([
    {
      name: 'authjs.session-token',
      value: sessionToken,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      expires: Math.floor(expires.getTime() / 1000),
    },
  ]);

  // Now navigate; the cookie is sent with the first request and the
  // server resolves the session via DrizzleAdapter.
  await page.goto(redirectTo);
}
