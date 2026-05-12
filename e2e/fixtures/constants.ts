/**
 * Single source of truth for E2E identifiers, prefixes, and timeouts.
 *
 * **How tests model users and data** — full detail in e2e/TESTING-MODES.md:
 *
 * 1. **Seeded personas** — `FIXTURE_EMAIL` (planner) + `REMEDIATION_FIXTURE_EMAIL`
 *    (incomplete vehicle gate); globalSetup runs `seed-e2e-fixture.ts` for both.
 * 2. **Planner + `playwright-*` rows** — same primary user; mid-suite trips/vehicles
 *    use `RUN_ID` + `playwrightName()`; teardown scrubs `playwright-*`.
 * 3. **Real login flows** — optional OTP (`E2E_OTP_EMAIL`) or OAuth; distinct from
 *    cookie-based `loginAsFixtureUser` / `loginAsE2eUser`.
 *
 * Why centralise this:
 *   - Several scripts need the same prefix (the seed creates rows with it,
 *     the cleanup script deletes rows that match it). Drift between them
 *     would either leak rows or wipe legitimate developer data.
 *   - A unique runId per process makes parallel local + CI runs against
 *     the shared Neon DB safe — each run only mutates rows it created.
 *   - The fixture email is referenced by playwright.config.ts (sets
 *     AUTH_TEST_BACKDOOR_EMAIL), the seed script (creates the user), and
 *     several tests (logs in via the backdoor).
 */

/** Email used by the seeded fixture user. Backdoor logs in as this address. */
export const FIXTURE_EMAIL =
  process.env.E2E_FIXTURE_EMAIL || 'feral-e2e-fixture@feraltravels.test';

/** Display name on the fixture user row. */
export const FIXTURE_USER_NAME = 'E2E Fixture User';

/** The seeded trip's name. Tests look this up by name on /trips. */
export const FIXTURE_TRIP_NAME = 'E2E Fixture Trip';

/** Seeded vehicle on the fixture user. Penny + the workspace use it. */
export const FIXTURE_VEHICLE_NAME = 'E2E Fixture Van';

/**
 * **Remediation persona** — separate Auth user so remediation E2E never races
 * the default planner fixture (no shared trips / vehicle IDs). Global seed
 * wipes and rebuilds this user's graph like the primary fixture.
 */
export const REMEDIATION_FIXTURE_EMAIL =
  process.env.E2E_REMEDIATION_FIXTURE_EMAIL || 'feral-e2e-remediation@feraltravels.test';

export const REMEDIATION_USER_NAME = 'E2E Remediation Persona';

export const REMEDIATION_TRIP_NAME = 'E2E Remediation Trip';

/** Incomplete strict-driving profile; remediation flow fills the gaps. */
export const REMEDIATION_VEHICLE_NAME = 'E2E Remediation Van';

/**
 * Per-run identifier. Uses the high-resolution wall clock so two parallel
 * local + CI runs against the same DB never clash. All test-created rows
 * (vehicles, ad-hoc trips, etc.) carry this prefix in their name; the
 * cleanup script deletes anything matching `playwright-` — both the fixed
 * `playwright-` suffix and per-run rows are caught.
 */
export const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Always-prefix for any row the suite creates ad-hoc, so cleanup can find it. */
export const PLAYWRIGHT_NAME_PREFIX = 'playwright-';

/** Helper: name with the per-run id baked in, eg. `playwright-mn3x7-Test Vehicle`. */
export function playwrightName(label: string): string {
  return `${PLAYWRIGHT_NAME_PREFIX}${RUN_ID}-${label}`;
}

// ---------------------------------------------------------------------------
// OTP E2E — address on your Resend-verified domain (e.g. e2e-otp@feraltravels.com).
// The test types this on /login, triggers sendOtpCode(), then reads the same
// code from Postgres (`email_otp_codes`) — no third-party inbox API.

export const E2E_OTP_EMAIL = (process.env.E2E_OTP_EMAIL || '').trim();

/** When set, login-otp.spec.ts runs the real OTP UI flow (skipped otherwise). */
export function isOtpE2EConfigured(): boolean {
  return E2E_OTP_EMAIL.length > 0;
}
