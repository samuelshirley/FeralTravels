import type { Page } from '@playwright/test';
import { FIXTURE_EMAIL } from './constants';

/**
 * Sign in for E2E entirely over HTTP: POST the target app's guarded
 * `/api/test/session` endpoint, which mints a real Auth.js database session and
 * returns the session cookie. `page.request` shares the browser context's
 * cookie jar, so the Set-Cookie lands in the context and the subsequent
 * `page.goto` is authenticated — no direct DB access from the test.
 *
 * The endpoint only exists when `AUTH_TEST_BACKDOOR` is configured on the app
 * (off on real prod), which is exactly where E2E runs (local / preview).
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

export async function loginAsE2eUser(
  page: Page,
  email: string,
  opts: { redirectTo?: string } = {},
) {
  const redirectTo = opts.redirectTo || '/trips';
  const res = await page.request.post(`${targetBaseUrl()}/api/test/session`, {
    data: { email },
  });
  if (!res.ok()) {
    throw new Error(
      `[e2e/auth] /api/test/session failed (${res.status()}) for ${email}. ` +
        'Is AUTH_TEST_BACKDOOR configured on the target app?',
    );
  }
  // domcontentloaded — the full 'load' can stall on Maps/analytics sub-resources
  // while the page is already interactive; each test waits on its own assertions.
  await page.goto(redirectTo, { waitUntil: 'domcontentloaded' });
}

/** Sign in as the primary planner fixture user (`FIXTURE_EMAIL`). */
export async function loginAsFixtureUser(page: Page, opts: { redirectTo?: string } = {}) {
  return loginAsE2eUser(page, FIXTURE_EMAIL, opts);
}
