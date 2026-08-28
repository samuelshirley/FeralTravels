import { test, expect } from '@playwright/test';
import { testEndpointHeaders } from './fixtures/constants';

/**
 * The web is off. Prove it did not take the phone with it.
 *
 * This spec exists because "turn the web app off" and "turn the server off" are
 * one deployment apart. The iOS app IS calls to www.feraltravels.com/api/*, it
 * authenticates with `Authorization: Bearer` rather than a cookie, and nothing
 * running at the edge can tell it apart from a browser. A gate that reached one
 * path too far would not fail loudly — the site would look correct, and the app
 * would simply stop working for everyone at once.
 *
 * So the assertions are shaped around the two ways this goes wrong:
 *   1. something under /api gets swept up  → the product is down
 *   2. a legal page gets swept up          → App Store rejection
 *
 * Runs in the `api` project, unauthenticated, against the deployed preview
 * (which sets WEB_APP_ENABLED=0 to match production).
 */

/** No cookie, no bearer token — exactly what a stranger's browser sends. */
const anon = { headers: testEndpointHeaders() };

test.describe('web app off', () => {
  /**
   * THE one that takes the product down. A 401 here means the route ran and its
   * own guard refused — correct. A 307 to /get-the-app means the edge ate it,
   * and every phone with the app installed is dead.
   */
  test('every API route still answers from its own guard, not the web gate', async ({ request }) => {
    for (const path of [
      '/api/trips',
      '/api/me/entitlement',
      '/api/vehicles',
      '/api/trip?tripId=00000000-0000-0000-0000-000000000000',
    ]) {
      const res = await request.get(path, { ...anon, maxRedirects: 0 });
      expect(
        res.status(),
        `${path} must be refused by its own auth guard (401), not redirected by the web gate`
      ).toBe(401);
    }
  });

  test('the native sign-in routes are reachable with no session at all', async ({ request }) => {
    // Requesting a code IS the start of signing in — there is no session yet by
    // definition. A redirect here means nobody can sign in on a fresh install.
    const res = await request.post('/api/mobile/otp/send', {
      ...anon,
      data: { email: 'nobody@e2e.feraltravels.com' },
      maxRedirects: 0,
    });
    expect(res.status(), 'POST /api/mobile/otp/send must not be redirected').toBeLessThan(400);
  });

  /**
   * These exact URLs are typed into App Store Connect and the Google Cloud
   * console, and both are fetched ANONYMOUSLY by a reviewer or a crawler.
   * `legal-pages.spec.ts` asserts they render; this asserts the web gate did
   * not quietly take them.
   */
  for (const path of ['/privacy', '/terms', '/support']) {
    test(`${path} survives the web being switched off`, async ({ request }) => {
      const res = await request.get(path, { ...anon, maxRedirects: 0 });
      expect(res.status(), `${path} is submitted to Apple/Google — a redirect here is a rejection`).toBe(200);
    });
  }

  test('signing in still works, for the one account that may', async ({ request }) => {
    const res = await request.get('/login', { ...anon, maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });

  /** And the part that IS supposed to be blocked, actually is. */
  for (const path of ['/', '/trips', '/settings', '/vehicle-setup', '/admin']) {
    test(`${path} shows the download screen to a stranger`, async ({ request }) => {
      const res = await request.get(path, { ...anon, maxRedirects: 0 });
      expect(res.status(), `${path} should redirect`).toBeGreaterThanOrEqual(300);
      expect(res.status()).toBeLessThan(400);
      expect(res.headers()['location'] ?? '', `${path} should land on the download screen`).toContain(
        '/get-the-app'
      );
    });
  }

  test('the download screen renders and offers the App Store', async ({ page }) => {
    const res = await page.goto('/get-the-app');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const cta = page.getByRole('link', { name: /App Store/i });
    await expect(cta).toBeVisible();
    // Not asserted as the literal fallback: setting NEXT_PUBLIC_APP_STORE_URL
    // to the real listing id later must not red this.
    expect(new URL(await cta.getAttribute('href') ?? '').hostname).toContain('apple.com');
  });

  /** A reviewer who lands here must still be able to reach the documents. */
  test('the download screen links to the legal pages', async ({ page }) => {
    await page.goto('/get-the-app');
    for (const name of ['Privacy', 'Terms', 'Support']) {
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    }
  });
});
