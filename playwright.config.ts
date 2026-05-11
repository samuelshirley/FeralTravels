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
 *   run gets isolated by:
 *     1. A fixed seeded fixture user (created idempotently by
 *        `scripts/seed-e2e-fixture.ts`, persists between runs).
 *     2. Playwright-created trips/vehicles that all carry a
 *        `playwright-<runId>-` name prefix, deleted by `scripts/cleanup-e2e.ts`
 *        after the suite finishes (globalTeardown).
 *
 * - Single browser project (chromium) — we're not testing rendering quirks,
 *   we're testing app behaviour. Multiple browsers would ~3× the run time
 *   without catching anything we'd actually act on.
 *
 * Full `npm run e2e` can feel "frozen" for several minutes: `webServer` runs
 * `npm run build` (quiet on success), then the Penny test waits up to ~150s
 * for Anthropic streaming. Use `npm run e2e:smoke` for the fast path (no Penny).
 */

// Read .env so DATABASE_URL, E2E_OTP_EMAIL, AUTH_TEST_BACKDOOR_*, etc. are
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

// Local: parallelise across spec files (still serial within a file). CI stays
// single-worker to reduce DB fixture contention and Anthropic rate pressure.
// Override any time: PW_WORKERS=1 npx playwright test
const playwrightWorkers = process.env.PW_WORKERS
  ? parseInt(process.env.PW_WORKERS, 10)
  : process.env.CI
    ? 1
    : 5;

export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  // E2E runs serially per file by default; tests within a file are
  // independent and safe to parallelise. The Penny test calls Anthropic —
  // locally we still default to several workers (see playwrightWorkers); CI
  // uses 1. Use PW_WORKERS=1 if you see flakiness or quota issues.
  fullyParallel: false,
  workers: Number.isFinite(playwrightWorkers) && playwrightWorkers > 0 ? playwrightWorkers : 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
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
    extraHTTPHeaders: { 'x-e2e-test': '1' },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(useExternalServer
    ? {}
    : {
        webServer: {
          // We deliberately do NOT run `npm run db:push` here — the suite
          // assumes the DB schema is already current (which it is for
          // anyone who has run `ship` or `db:push` before). The seed
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
            // The login backdoor must be ON for the test suite. We set
            // it here (not in .env) so the developer's `npm run dev`
            // doesn't unexpectedly enable it — only tests turn it on.
            AUTH_TEST_BACKDOOR: '1',
            AUTH_TEST_BACKDOOR_EMAIL:
              process.env.AUTH_TEST_BACKDOOR_EMAIL ||
              process.env.E2E_FIXTURE_EMAIL ||
              'feral-e2e-fixture@feraltravels.test',
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
