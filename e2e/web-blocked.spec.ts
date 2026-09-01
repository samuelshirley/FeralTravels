import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
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
 * Runs in the `api` project, unauthenticated, against the deployed preview.
 *
 * WHICH SIDE OF THE SWITCH IT IS ON. `WEB_APP_ENABLED` is fixed for the life of
 * a deployment, so one preview cannot exercise both states. Rather than skip
 * half this file on the side it is not on — a skip reds the build, because
 * E2E_MAX_SKIPPED is 0, and a suite that quietly tests nothing is the failure
 * this repo has already had once — every test below asserts the CORRECT
 * behaviour for the configuration it finds, keyed on the Playwright PROJECT.
 *
 * Most of it does not care either way: /api, the legal pages and /login are
 * never gated in either configuration, and those are the assertions that stop
 * this becoming an outage or an App Store rejection. Only the five page paths
 * at the bottom differ, and there they are the more useful assertion in the
 * web-ON case: they prove the gate ships INERT, which is exactly the
 * configuration going to production with the flag unset.
 */

/**
 * True when the preview deployed with the web app ON. Set beside
 * `E2E_BASE_URL` in ci.yml, by the same step that decides the deploy flag, so
 * the two cannot drift apart silently.
 */
/**
 * What the deployment ACTUALLY does, discovered by asking it.
 *
 * The first version keyed off `E2E_WEB_UI`, which is a Playwright PROJECT
 * switch — a different variable, on a different machine, kept in step with
 * `WEB_APP_ENABLED` by hand. Two names for one fact is the drift this whole
 * spec exists to catch, so it now probes the running app instead: send an
 * anonymous request to a gated page and read where it is sent.
 *
 *   → /get-the-app  the web gate engaged      → WEB_APP_ENABLED=0
 *   → /login        ordinary auth redirect    → the gate is off
 *
 * INTENT comes from the project name. ci.yml runs this spec twice: once in the
 * `api` project against the ordinary preview, and once in `web-blocked` against
 * a second deployment of the same build carrying WEB_APP_ENABLED=0. So project
 * -> deployment -> flag is one chain with nothing to keep in step by hand.
 *
 * Observed and intended are then compared, and a mismatch is the most valuable
 * failure this file can produce: it means the env var did not take, which is
 * exactly how a paywall shipped unenforced for a fortnight while the admin
 * panel cheerfully reported the right state.
 */
type WebState = 'blocked' | 'open';

async function observeWebState(request: APIRequestContext): Promise<WebState> {
  const res = await request.get('/trips', { ...anon, maxRedirects: 0 });
  const location = res.headers()['location'] ?? '';
  if (location.includes('/get-the-app')) return 'blocked';
  if (location.includes('/login')) return 'open';
  throw new Error(
    `Could not tell which state the web app is in. GET /trips answered ${res.status()} ` +
      `-> "${location}", which is neither the gate (/get-the-app) nor the auth redirect (/login).`
  );
}

/**
 * Probed once PER WORKER, not once per run.
 *
 * `fullyParallel` is on, so these tests are spread across four workers in
 * separate processes. A value set inside one test is invisible to the others —
 * the first draft of this file did exactly that and every worker but one would
 * have asserted against the default. `beforeAll` runs in each worker, so each
 * pays one extra request and every test reads the truth.
 */
let observed: WebState;
let WEB_ON = true;

test.beforeAll(async ({}, testInfo) => {
  // The project's OWN baseURL, not the ambient env var. The `web-blocked`
  // project points at a second deployment of the same build with
  // WEB_APP_ENABLED=0; reading E2E_BASE_URL here would have probed the open one
  // and then asserted the blocked contract against it.
  const ctx = await playwrightRequest.newContext({
    baseURL:
      (testInfo.project.use.baseURL as string | undefined) ||
      process.env.E2E_BASE_URL ||
      `http://localhost:${process.env.E2E_PORT || 4444}`,
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    observed = await observeWebState(ctx);
    WEB_ON = observed === 'open';
  } finally {
    await ctx.dispose();
  }
});

/** No cookie, no bearer token — exactly what a stranger's browser sends. */
const anon = { headers: testEndpointHeaders() };

test.describe('web app off', () => {
  /**
   * FIRST, and everything else depends on it. Establishes which state the
   * deployment is in and — when CI said which state it meant — proves the
   * variable actually took effect.
   */
  test('the web switch is in the state this deployment intended', async ({}, testInfo) => {
    // Intent comes from the PROJECT, and the project comes from which
    // deployment ci.yml aimed it at — which came from the WEB_APP_ENABLED value
    // it passed to `vercel deploy`. One chain, no second variable to keep in
    // step by hand. The earlier version read E2E_WEB_UI, a Playwright switch on
    // a different machine, which is the drift this file exists to catch.
    const expected: WebState = testInfo.project.name === 'web-blocked' ? 'blocked' : 'open';
    expect(
      observed,
      `Project "${testInfo.project.name}" targets a deployment that should be ${expected}, ` +
        `but it is ${observed}. The WEB_APP_ENABLED value ci.yml passed to \`vercel deploy\` ` +
        `did not take effect. Every assertion below is now checking the wrong contract, so ` +
        `fix this before reading any other failure in this file.`
    ).toBe(expected);
  });

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

  test('the native sign-in routes are reachable with no session at all', async ({
    request,
  }, testInfo) => {
    // Requesting a code IS the start of signing in — there is no session yet by
    // definition. A redirect here means nobody can sign in on a fresh install.
    //
    // THE ADDRESS IS DERIVED, NOT A CONSTANT, and both halves of it are load
    // bearing.
    //
    // UNIQUE, because this spec now runs in two projects against two
    // deployments that share ONE database, and `sendOtpCode` enforces a
    // 60-second resend cooldown keyed on the address. With one constant address
    // the `api` project sent the code and `web-blocked` got the 429 it earned —
    // a red build with nothing whatsoever wrong with the app. The timestamp
    // covers retries too: all three attempts fell inside the same minute.
    //
    // `playwright-` PREFIXED, because anything that does not match
    // FIXTURE_EMAIL_PATTERN falls through to a real Resend send, and
    // e2e.feraltravels.com has no MX — so every run was hard-bouncing off the
    // same domain the live sign-in emails go out from. The route still runs end
    // to end: the code is generated and stored before the transport is skipped,
    // and this test only ever cared that the request was not redirected.
    const email = `playwright-webgate-${testInfo.project.name}-${Date.now()}@e2e.feraltravels.com`;
    const res = await request.post('/api/mobile/otp/send', {
      ...anon,
      data: { email },
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

  /**
   * The pages that the gate is actually about — asserted from whichever side
   * this deployment is on.
   *
   * Both branches expect a redirect: a stranger never reaches these either way.
   * What differs is WHERE, and that is the whole question. With the flag unset
   * they must fall through to the ordinary auth redirect, and landing on
   * /get-the-app instead would mean the gate engaged when nobody asked it to —
   * the exact regression that would take the web app down for everyone the
   * moment this branch merges.
   */
  for (const path of ['/', '/trips', '/settings', '/vehicle-setup', '/admin']) {
    test(`${path} never renders for a stranger`, async ({ request }) => {
      // FOLLOWING the redirects, not asserting the first hop.
      //
      // `/vehicle-setup` is why. It is a legacy stub whose entire body is
      // `redirect('/trips')` — remediation moved into the chat composer long
      // ago, but Penny's prompt and StopsSection still link to it. So an
      // anonymous request there answers 307 -> /trips and only THEN -> /login:
      // two hops to the same place every other path reaches in one. Asserting
      // the first hop failed this spec on a route that was behaving correctly.
      //
      // The contract worth holding is the user-visible one: a stranger ends up
      // signing in, or being told to get the app. Never inside.
      const res = await request.get(path, { ...anon });
      const final = new URL(res.url()).pathname;

      expect(final, `${path} must not render for a stranger`).not.toBe(path);
      if (WEB_ON) {
        expect(final, `${path} should end at sign-in while the web app is on`).toBe('/login');
      } else {
        expect(final, `${path} should end at the download screen`).toBe('/get-the-app');
      }
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
