import type { Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { FIXTURE_EMAIL } from './constants';
import { getDb, schema } from './db';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirrors src/server/auth/otp.ts

/**
 * Sign in as any seeded E2E user by inserting an Auth.js database session +
 * cookie (same mechanism as OTP sign-in — see fixtures header comment below).
 */
export async function loginAsE2eUser(page: Page, email: string, opts: { redirectTo?: string } = {}) {
  const redirectTo = opts.redirectTo || '/trips';

  const db = getDb();
  const userRow = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1)
  )[0];
  if (!userRow) {
    throw new Error(
      `[e2e/auth] E2E user ${email} not found. Did global setup run? Try \`npm run e2e:seed\`.`,
    );
  }

  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await db.insert(schema.sessions).values({
    sessionToken,
    userId: userRow.id,
    expires,
  });

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

  // Use domcontentloaded — the full 'load' event can stall on slow
  // sub-resources (fonts, analytics, Google Maps JS) while the page is
  // already interactive. Every test waits for its own content assertions
  // after login anyway.
  await page.goto(redirectTo, { waitUntil: 'domcontentloaded' });
}

/**
 * Sign in as the primary planner fixture user (`FIXTURE_EMAIL`).
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
  return loginAsE2eUser(page, FIXTURE_EMAIL, opts);
}
