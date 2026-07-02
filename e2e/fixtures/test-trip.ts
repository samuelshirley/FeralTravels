import { request, type APIRequestContext } from '@playwright/test';
import {
  FIXTURE_EMAIL,
  FIXTURE_USER_NAME,
  FIXTURE_TRIP_NAME,
  FIXTURE_VEHICLE_NAME,
  playwrightName,
  testBackdoorHeaders,
} from './constants';

/**
 * Ad-hoc trip fixtures, driven over HTTP through the app's guarded
 * `/api/test/*` endpoints instead of raw SQL. Each helper spins up a
 * standalone Playwright request context (no browser/page needed) — the
 * endpoints authorize by the `AUTH_TEST_BACKDOOR` env guard, not a session.
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: testBackdoorHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

async function createTrip(
  kind: 'blank' | 'onboarding' | 'vehicle_new',
  label: string,
): Promise<{ tripId: string; vehicleId: string | null; name: string }> {
  const name = playwrightName(label);
  return withApi(async (ctx) => {
    const res = await ctx.post('/api/test/trip', {
      data: { email: FIXTURE_EMAIL, name, kind },
    });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] create ${kind} trip failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { tripId: string; vehicleId: string | null };
    return { tripId: body.tripId, vehicleId: body.vehicleId ?? null, name };
  });
}

/**
 * Empty trip with `onboarding_state='done'` and the fixture's default vehicle —
 * lets the Penny submit test skip onboarding and type straight into the chat.
 */
export async function createBlankPlanningTrip(label: string): Promise<{ tripId: string; name: string }> {
  const { tripId, name } = await createTrip('blank', label);
  return { tripId, name };
}

/**
 * Trip fixed at `onboarding_state='not_started'` — the wizard walks
 * trip_intent → trip_date → units_pick. No vehicle attached.
 */
export async function createOnboardingTrip(label: string): Promise<{ tripId: string; name: string }> {
  const { tripId, name } = await createTrip('onboarding', label);
  return { tripId, name };
}

/**
 * Trip fixed at `onboarding_state='vehicle_new'` with an intentionally
 * incomplete vehicle (no range) — exercises numeric validation in the composer.
 */
export async function createVehicleNewProfileTrip(
  label: string,
): Promise<{ tripId: string; vehicleId: string; name: string }> {
  const { tripId, vehicleId, name } = await createTrip('vehicle_new', label);
  if (!vehicleId) throw new Error('[e2e/test-trip] vehicle_new trip returned no vehicleId');
  return { tripId, vehicleId, name };
}

/**
 * Tear down the extra trip + vehicle from {@link createVehicleNewProfileTrip}.
 * Both are `playwright-`-prefixed, so the cleanup endpoint sweeps them (and any
 * other stray playwright rows) for the fixture user.
 */
export async function deleteVehicleNewProfileFixture(_opts: {
  tripId: string;
  vehicleId: string;
}): Promise<void> {
  await cleanupPlaywrightFixtureData();
}

/** Delete all `playwright-`-prefixed trips + vehicles for the fixture user. */
export async function cleanupPlaywrightFixtureData(): Promise<void> {
  await withApi(async (ctx) => {
    const res = await ctx.post('/api/test/cleanup', { data: { email: FIXTURE_EMAIL } });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] cleanup failed (${res.status()}): ${await res.text()}`);
    }
  });
}

/** Back-compat alias used by older specs. */
export async function deleteFixtureUserPlaywrightTrips(): Promise<void> {
  await cleanupPlaywrightFixtureData();
}

/**
 * Re-seed the canonical fixture (same payload as globalSetup): deletes the
 * fixture user's trips/vehicles and recreates the vehicle + trip + two legs.
 * Use when a spec needs the seeded trip in a KNOWN-FRESH state — e.g.
 * lazy-fuel-sourcing needs legs with `fuel_status='none'`, but an earlier spec
 * (existing-trip) expands leg 1 and sources its fuel, leaving a fresh cache
 * that correctly suppresses the lazy POST the spec asserts on.
 */
export async function reseedCanonicalFixture(): Promise<void> {
  await withApi(async (ctx) => {
    const res = await ctx.post('/api/test/seed', {
      data: {
        email: FIXTURE_EMAIL,
        userName: FIXTURE_USER_NAME,
        vehicleName: FIXTURE_VEHICLE_NAME,
        tripName: FIXTURE_TRIP_NAME,
      },
    });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] reseed failed (${res.status()}): ${await res.text()}`);
    }
  });
}

/** Count the legs on a trip via the authenticated trip API (post-Penny assertion). */
export async function countLegs(tripId: string): Promise<number> {
  return withApi(async (ctx) => {
    await ctx.post('/api/test/session', { data: { email: FIXTURE_EMAIL } });
    const res = await ctx.get(`/api/trips/${tripId}`);
    if (!res.ok()) return 0;
    const body = (await res.json()) as { legs?: unknown[]; trip?: { legs?: unknown[] } };
    const legs = body.legs ?? body.trip?.legs ?? [];
    return Array.isArray(legs) ? legs.length : 0;
  });
}
