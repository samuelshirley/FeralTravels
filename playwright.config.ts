import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright configuration for the trip-planner E2E suite.
 *
 * Why these defaults:
 * - We auto-spin a production `next start` against a fixed port (4444) so the
 *   suite is self-contained — you don't have to remember to leave `npm run dev`
 *   running, and the build matches what Vercel would deploy. The dev server
 *   is intentionally NOT used: HMR + dynamic compile makes the very first
 *   page navigation in each test wait 5–15s for the route to compile, which
 *   produced flaky timeouts.
 *
 * - The Penny submit-trip test really does call Anthropic + Google Places
 *   live, so the per-test timeout is 90s. Other tests cap out around the
 *   default 30s.
 *
 * - We hit the same Neon DB the dev app uses (DATABASE_URL from .env). Each
 *   run starts from a clean fixture account *data-wise* (all trips + vehicles
 *   for the fixture user are deleted, then re-seeded — see
 *   `scripts/seed-e2e-fixture.ts`). During the suite, tests also create
 *   `playwright-<runId>-` trips/vehicles; `scripts/cleanup-e2e.ts` removes
 *   those rows at globalTeardown. Specs that insert an **extra** vehicle on
 *   `FIXTURE_EMAIL` must clean it before later specs (e.g. vehicle CRUD assumes
 *   a sole seeded van mid-run); teardown alone runs too late.
 *
 * - **Fully parallel, one fresh user per test.** Every spec mints its own
 *   `playwright-<runid>-...@e2e.feraltravels.com` address, signs in through the
 *   real OTP flow, and seeds its own fixture graph over `/api/test/*`. Nothing
 *   is shared, so nothing can race. The announcement spec is the exception —
 *   announcements are global app state — and runs alone in its own project.

 *
 * - Single browser project (chromium) — we're not testing rendering quirks,
 *   we're testing app behaviour. Multiple browsers would ~3× the run time
 *   without catching anything we'd actually act on.
 *
 * Full `npm run e2e` can feel "frozen" for several minutes: `webServer` runs
 * `npm run build` (quiet on success), then the Penny test waits up to ~150s
 * for Anthropic streaming. Use `npm run e2e:smoke` for the fast path (no Penny).
 */

// Read .env so DATABASE_URL, E2E_TEST_ENDPOINTS_*, etc. are
// available to test code without exporting them in the shell. dotenv is
// already a devDep for the migrate scripts.
import 'dotenv/config';

// Keep the test app on its own port so a developer's `npm run dev` on :3000
// doesn't collide with the suite. Override with E2E_PORT env if 4444 is taken.
const PORT = Number(process.env.E2E_PORT) || 4444;
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

// Whether to skip starting our own webServer (useful when E2E_BASE_URL points
// at an already-running app, e.g. a Vercel preview URL).
const useExternalServer = !!process.env.E2E_BASE_URL;

// Global setup resets seeded persona graphs once per run. `workers` stays 1 so
// mid-suite playwright-* rows don't race unrelated specs until we shard DBs.

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  // Every spec signs in as its OWN fresh user and seeds its OWN data, so there
  // is no shared state left to race — which is what makes parallel safe. The
  // one exception is the announcement, which is global to the app; it runs in
  // its own project after everything else (see `projects` below).
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    // Machine-readable run stats. CI feeds this to scripts/assert-e2e-ran.mjs,
    // which fails the build when the suite mass-SKIPPED —
    // a green-but-empty run would otherwise auto-ship to production on merge.
    ['json', { outputFile: 'playwright-results.json' }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: path.join(__dirname, 'e2e/global-setup.ts'),
  globalTeardown: path.join(__dirname, 'e2e/global-teardown.ts'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Block the service worker entirely. /public/sw.js is fine in
    // production (it's network-first for navigations + cache-first for
    // hashed assets) but in headless Chromium it occasionally races with
    // page.reload() — the SW's install/activate cycle holds page loads
    // long enough for client-side useEffect chains to never fire,
    // producing stuck "Loading…" spinners that look like API failures.
    // The suite isn't testing the SW; turning it off keeps page reloads
    // deterministic.
    serviceWorkers: 'block',
    // Test-only header lets server code recognise E2E traffic if it ever
    // wants to short-circuit something (currently unused; reserved for
    // future use, e.g. if Penny gains a "deterministic mode").
    //
    // When the target is the CI-tested Vercel preview, we also carry:
    // - x-e2e-test-secret (E2E_TEST_ENDPOINTS_SECRET): required by the
    //   /api/test/* fixture endpoints so a leaked preview URL can't seed or
    //   delete fixture data. Browser-context requests inherit these headers;
    //   standalone request.newContext() calls add them via
    //   testEndpointHeaders() in e2e/fixtures/constants.ts.
    // - x-vercel-protection-bypass (VERCEL_AUTOMATION_BYPASS_SECRET): lets
    //   the suite through Vercel Deployment Protection if it's enabled.
    extraHTTPHeaders: {
      'x-e2e-test': '1',
      ...(process.env.E2E_TEST_ENDPOINTS_SECRET?.trim()
        ? { 'x-e2e-test-secret': process.env.E2E_TEST_ENDPOINTS_SECRET.trim() }
        : {}),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
        ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET.trim() }
        : {}),
    },
  },
  projects: [
    // Everything except the announcement. Fully parallel: one fresh user per
    // test, one fresh fixture graph per test, nothing shared.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /announcement\.spec\.ts/,
    },
    // The announcement is GLOBAL app state — an active announcement pops a
    // modal over every signed-in user's /trips, which would block clicks in
    // any spec running beside it. So it runs on its own, after the rest.
    {
      name: 'announcement',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /announcement\.spec\.ts/,
      dependencies: ['chromium'],
    },
  ],
  ...(useExternalServer
    ? {}
    : {
        webServer: {
          // We deliberately do NOT run `npm run db:push` here — the suite
          // assumes the DB schema is already current (which it is for
          // anyone who has run `db:migrate` or `db:push` before). The seed
          // script in globalSetup is what guarantees fixture rows exist.
          //
          // `npm run build` is included so a fresh checkout works, but
          // Next caches under .next/ so subsequent runs only do the cheap
          // incremental build.
          command: `npm run build && npx next start -p ${PORT}`,
          url: `${BASE_URL}/login`,
          reuseExistingServer: !process.env.CI,
          // First-time build can take ~60s on a cold cache; subsequent
          // runs are ~5s. 180s gives us comfortable headroom.
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
          env: {
            // Pass through everything the app needs at runtime first
            // (DATABASE_URL, ANTHROPIC_API_KEY, etc.) — then layer the
            // test-only overrides on top so they always win.
            ...process.env,
            // The /api/test/* FIXTURE endpoints must be ON for the suite
            // (seed/reset/cleanup of test data — there is no auth bypass;
            // sign-in goes through the real OTP flow). Set
            // here (not in .env) so a developer's `npm run dev` doesn't
            // unexpectedly expose them — only tests turn them on.
            E2E_TEST_ENDPOINTS: '1',
            AUTH_URL: BASE_URL,
            // The TripMap component reads NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
            // (Next bakes NEXT_PUBLIC_ vars into the client bundle at
            // build time). If only the server-side GOOGLE_MAPS_API_KEY
            // is set in .env, mirror it so the e2e map render assertions
            // don't fail with "API key not set". Already-set values win.
            NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:
              process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
              process.env.GOOGLE_MAPS_API_KEY ||
              '',
          },
        },
      }),
});
