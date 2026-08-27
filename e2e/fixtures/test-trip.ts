import { request, type APIRequestContext, type Page } from '@playwright/test';
import {
  FIXTURE_USER_NAME,
  FIXTURE_TRIP_NAME,
  FIXTURE_VEHICLE_NAME,
  playwrightName,
  testEndpointHeaders,
} from './constants';

/**
 * Fixture-data helpers, driven over HTTP through the app's guarded
 * `/api/test/*` endpoints instead of raw SQL. Each helper spins up a
 * standalone Playwright request context (no browser/page needed) — the
 * endpoints authorize by the `E2E_TEST_ENDPOINTS` env guard (+ per-run
 * secret in CI), not a session, and only touch fixture DATA.
 *
 * Every helper takes the disposable test user's email (from
 * `createFreshUser()` in ./auth.ts) — there is no shared fixture account.
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Seed the canonical fixture graph (default vehicle + trip + two legs) for
 * `email`, creating the user row if needed. Same payload globalSetup used to
 * send for the shared persona; now each spec seeds its own fresh user.
 */
export async function seedCanonicalFixture(email: string): Promise<void> {
  await withApi(async (ctx) => {
    const res = await ctx.post('/api/test/seed', {
      data: {
        email,
        userName: FIXTURE_USER_NAME,
        vehicleName: FIXTURE_VEHICLE_NAME,
        tripName: FIXTURE_TRIP_NAME,
      },
    });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] seed failed (${res.status()}): ${await res.text()}`);
    }
  });
}

/** Back-compat name: re-seeding and seeding are the same POST. */
export const reseedCanonicalFixture = seedCanonicalFixture;

async function createTripFor(
  email: string,
  kind: 'blank' | 'onboarding' | 'vehicle_new',
  label: string,
): Promise<{ tripId: string; vehicleId: string | null; name: string }> {
  const name = playwrightName(label);
  return withApi(async (ctx) => {
    const res = await ctx.post('/api/test/trip', {
      data: { email, name, kind },
    });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] create ${kind} trip failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { tripId: string; vehicleId: string | null };
    return { tripId: body.tripId, vehicleId: body.vehicleId ?? null, name };
  });
}

/**
 * Empty trip with `onboarding_state='done'` and a vehicle — lets the Penny
 * submit test skip onboarding and type straight into the chat.
 *
 * The vehicle is now GUARANTEED, not inherited: this used to take whatever
 * `getDefaultVehicleId` returned, so calling it for an account that had not
 * been seeded produced a trip that had left onboarding with no vehicle
 * anywhere — a state the app cannot reach, and one whose every day renders
 * "Finish your vehicle profile". The fixture layer creates the Hilux when the
 * account owns nothing usable, and refuses to hand back an impossible trip.
 * Seeding the canonical fixture first is still fine; it is no longer required.
 */
export async function createBlankPlanningTrip(
  email: string,
  label: string,
): Promise<{ tripId: string; name: string }> {
  const { tripId, name } = await createTripFor(email, 'blank', label);
  return { tripId, name };
}

/**
 * Trip fixed at `onboarding_state='not_started'` — the wizard walks
 * trip_intent → trip_date → units_pick. No vehicle attached.
 */
export async function createOnboardingTrip(
  email: string,
  label: string,
): Promise<{ tripId: string; name: string }> {
  const { tripId, name } = await createTripFor(email, 'onboarding', label);
  return { tripId, name };
}

/**
 * Trip fixed at `onboarding_state='vehicle_new'` with an intentionally
 * incomplete vehicle (no range) — exercises numeric validation in the composer.
 */
export async function createVehicleNewProfileTrip(
  email: string,
  label: string,
): Promise<{ tripId: string; vehicleId: string; name: string }> {
  const { tripId, vehicleId, name } = await createTripFor(email, 'vehicle_new', label);
  if (!vehicleId) throw new Error('[e2e/test-trip] vehicle_new trip returned no vehicleId');
  return { tripId, vehicleId, name };
}

/** Delete all `playwright-`-prefixed trips + vehicles for `email`. */
export async function cleanupPlaywrightFixtureData(email: string): Promise<void> {
  await withApi(async (ctx) => {
    const res = await ctx.post('/api/test/cleanup', { data: { email } });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] cleanup failed (${res.status()}): ${await res.text()}`);
    }
  });
}

/**
 * Count the legs on a trip via the authenticated trip API (post-Penny
 * assertion). Uses the PAGE's browser context — the caller is already signed
 * in via the real OTP flow — so the request carries the session cookie.
 * Reads `GET /api/trip?tripId=` (the full-trip endpoint backed by getTripFull)
 * — NOT `/api/trips/[id]`, which has no GET handler (PATCH/DELETE only).
 * Failures THROW so a broken helper is distinguishable from an empty plan.
 */
export async function countLegs(page: Page, tripId: string): Promise<number> {
  const res = await page.request.get(`/api/trip?tripId=${tripId}`);
  if (!res.ok()) {
    throw new Error(`[e2e/countLegs] GET /api/trip failed (${res.status()}): ${await res.text()}`);
  }
  const body = (await res.json()) as { legs?: unknown[] };
  return Array.isArray(body.legs) ? body.legs.length : 0;
}
