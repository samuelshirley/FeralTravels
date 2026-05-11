import { test, expect } from '@playwright/test';

/**
 * We can't actually complete a Google sign-in from a Playwright test —
 * Google blocks headless browsers and the captcha/2FA flow can't be
 * scripted reliably. What we CAN test (and should) is that the button on
 * /login points at the right place: the correct OAuth URL on
 * accounts.google.com, with the configured client_id and scopes.
 *
 * If a refactor accidentally swaps the form action or the configured
 * AUTH_GOOGLE_ID, this test catches it before users hit "Continue with
 * Google" in production and find themselves on a broken auth screen.
 *
 * Strategy:
 *   1. Open /login.
 *   2. Click the button. The form is a Next.js server action, so the
 *      sequence is:
 *        - POST to /login (server action runs)
 *        - 303 → /api/auth/signin/google?... (Auth.js handler)
 *        - 302 → https://accounts.google.com/o/oauth2/v2/auth?...
 *   3. Wait for the cross-origin navigation request to accounts.google.com
 *      to start; capture its URL. We don't care that the page itself
 *      eventually errors — we only need the URL the browser was sent to.
 *   4. Assert the captured URL has the right host, client_id, and the
 *      basic OIDC scopes (email + profile + openid) Auth.js asks for.
 */
test.describe('Google login button', () => {
  test('points at accounts.google.com with the right OAuth params', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-google-button')).toBeVisible();

    // page.route() with abort() doesn't reliably intercept the final
    // cross-origin navigation in Next.js server-action redirect chains
    // (the redirect happens server-side and the browser sees a single
    // 302 to Google, which navigates the document — Playwright's
    // request listener catches it but the route handler runs in a
    // different timing window). waitForRequest is more dependable.
    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().startsWith('https://accounts.google.com/'),
        { timeout: 15_000 },
      ),
      page.getByTestId('login-google-button').click(),
    ]);

    const url = new URL(request.url());

    expect(url.hostname).toBe('accounts.google.com');
    // Auth.js v5's Google provider redirects to the new v2 endpoint.
    expect(url.pathname).toBe('/o/oauth2/v2/auth');

    // Required OAuth params. We check shape rather than exact equality
    // for client_id (it's a public id but spelling matters more than
    // the literal value being baked into the test).
    const clientId = url.searchParams.get('client_id');
    expect(clientId, 'client_id query param missing').toBeTruthy();
    expect(clientId).toMatch(/\.apps\.googleusercontent\.com$/);

    expect(url.searchParams.get('response_type')).toBe('code');

    // We intentionally do not assert `state`: Auth.js v5 may use a
    // double-submit cookie / encrypted session for CSRF instead of a
    // visible query param on this URL.

    const scope = url.searchParams.get('scope') || '';
    expect(scope).toContain('openid');
    expect(scope).toContain('email');
    expect(scope).toContain('profile');

    // We told the provider `prompt: select_account` in src/server/auth/index.ts
    // so users always get the picker — verify it's still there.
    expect(url.searchParams.get('prompt')).toBe('select_account');

    // The redirect URI should point back at our /api/auth/callback/google
    // endpoint. Don't pin the host (it varies by env) but require the path.
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    expect(redirectUri).toContain('/api/auth/callback/google');
  });
});
