import { test, expect } from '@playwright/test';

/**
 * feraltravels.com/hotels proxies to the hotel finder (next.config.js
 * rewrites). #108 shipped a rule that sent bare /hotels to `…/hotels/`; the
 * hotel finder 308s that to /hotels, and production redirected to itself
 * forever (2026-11-12). Nothing caught it: no test fetched /hotels.
 *
 * Anonymous on purpose — the page is public (src/lib/paywallPaths.ts), and a
 * sign-in redirect would be a failure too. Hits the REAL hotel finder through
 * the preview's rewrite, which is the thing that broke.
 */
for (const path of ['/hotels', '/hotels/'] as const) {
  test(`${path} serves the hotel finder: 200, no redirect loop, stays on our domain`, async ({ request, baseURL }) => {
    const res = await request.get(path, { maxRedirects: 3 });
    expect(res.status(), `${path} must end 200, got ${res.status()}`).toBe(200);
    const url = new URL(res.url());
    expect(url.pathname).toBe('/hotels');
    expect(url.host, 'proxied, not redirected off our domain').toBe(new URL(baseURL!).host);
    expect(await res.text()).toMatch(/<html/i);
  });
}
