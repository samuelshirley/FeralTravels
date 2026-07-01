/**
 * Single source of truth for E2E identifiers, prefixes, and timeouts.
 *
 * Fixtures are created/reset entirely over HTTP via the app's guarded
 * `/api/test/*` endpoints (see e2e/fixtures/auth.ts + test-trip.ts and
 * e2e/global-setup.ts) — no direct database access.
 *
 * - `FIXTURE_EMAIL` is the seeded planner persona. globalSetup resets its graph
 *   (vehicle + trip + 2 legs) via `/api/test/seed` before each run.
 * - Mid-suite ad-hoc rows use `RUN_ID` + `playwrightName()`; teardown scrubs
 *   anything `playwright-`-prefixed via `/api/test/cleanup`.
 * - The real OTP UI flow (login-otp.spec) uses MailSlurp, gated on
 *   MAILSLURP_API_KEY — no address constant needed here.
 */

/** Email used by the seeded fixture user. The test-session endpoint signs in as this. */
export const FIXTURE_EMAIL =
  process.env.E2E_FIXTURE_EMAIL || 'feral-e2e-fixture@feraltravels.test';

/** Display name on the fixture user row. */
export const FIXTURE_USER_NAME = 'E2E Fixture User';

/** The seeded trip's name. Tests look this up by name on /trips. */
export const FIXTURE_TRIP_NAME = 'E2E Fixture Trip';

/** Seeded vehicle on the fixture user. Penny + the workspace use it. */
export const FIXTURE_VEHICLE_NAME = 'E2E Fixture Van';

/**
 * Per-run identifier. Uses the high-resolution wall clock so two parallel runs
 * never clash. All ad-hoc test rows carry this prefix in their name; cleanup
 * deletes anything matching `playwright-`.
 */
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Always-prefix for any row the suite creates ad-hoc, so cleanup can find it. */
export const PLAYWRIGHT_NAME_PREFIX = 'playwright-';

/** Helper: name with the per-run id baked in, eg. `playwright-mn3x7-Test Vehicle`. */
export function playwrightName(label: string): string {
  return `${PLAYWRIGHT_NAME_PREFIX}${RUN_ID}-${label}`;
}
