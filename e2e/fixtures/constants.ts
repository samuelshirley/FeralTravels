/**
 * Single source of truth for E2E identifiers, prefixes, and timeouts.
 *
 * Identity model: every test signs in as a FRESH user through the real OTP
 * flow (see fixtures/auth.ts), reading the code from the guarded
 * /api/test/otp endpoint — there is no auth bypass and no shared account. Fixture DATA (vehicle + trip + legs) is created for
 * that fresh user over HTTP via the app's guarded `/api/test/*` endpoints
 * (see test-trip.ts and the seed helpers) — no direct database access.
 *
 * - Mid-suite ad-hoc rows use `RUN_ID` + `playwrightName()`; specs scrub their
 *   own user's `playwright-`-prefixed rows via `/api/test/cleanup`.
 */
import { seededTripStartISO } from '../../src/app/api/test/seedDates';

/** Display name seeded onto each fresh test user's row. */
export const FIXTURE_USER_NAME = 'E2E Fixture User';

/** The seeded trip's name. Tests look this up by name on /trips. */
export const FIXTURE_TRIP_NAME = 'E2E Fixture Trip';

/** Seeded vehicle on the fresh test user. Penny + the workspace use it. */
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

/**
 * Headers every `/api/test/*` fixture call must carry. When
 * `E2E_TEST_ENDPOINTS_SECRET` is set on the target app (CI generates a random
 * one per run for the tested Vercel preview — see .github/workflows/pipeline.yml),
 * the endpoints require it echoed in `x-e2e-test-secret`; without the env this
 * is empty and local runs behave as before. Also carries the Vercel
 * deployment-protection bypass header when VERCEL_AUTOMATION_BYPASS_SECRET is set.
 */
export function testEndpointHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const secret = process.env.E2E_TEST_ENDPOINTS_SECRET?.trim();
  if (secret) headers['x-e2e-test-secret'] = secret;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  return headers;
}

/**
 * The date a spec types into the onboarding `trip_date` step, as a human
 * phrase ("3 June 2027") — the free-text shape a real driver types, which is
 * the input that step exists to parse.
 *
 * Derived from the same offset every seeded trip uses rather than written out,
 * because this spec used to type a literal `'June 3 2026'`. That was months
 * ahead when it was written and is now in the PAST, so the wizard it is
 * walking was quietly building a trip whose every day is already behind the
 * driver — the state that folds the itinerary shut. See
 * src/app/api/test/seedDates.ts.
 */
export function seededTripStartPhrase(): string {
  const [y, m, d] = seededTripStartISO().split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
