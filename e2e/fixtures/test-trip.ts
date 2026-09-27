import { request, type APIRequestContext } from '@playwright/test';
import {
  FIXTURE_USER_NAME,
  FIXTURE_TRIP_NAME,
  FIXTURE_VEHICLE_NAME,
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
export async function seedCanonicalFixture(
  email: string,
  opts: { rangeKm?: number; legPreset?: 'canonical' | 'three_long_drives' } = {},
): Promise<void> {
  await withApi(async (ctx) => {
    const res = await ctx.post('/api/test/seed', {
      data: {
        email,
        userName: FIXTURE_USER_NAME,
        vehicleName: FIXTURE_VEHICLE_NAME,
        tripName: FIXTURE_TRIP_NAME,
        ...(opts.rangeKm != null ? { rangeKm: opts.rangeKm } : {}),
        ...(opts.legPreset != null ? { legPreset: opts.legPreset } : {}),
      },
    });
    if (!res.ok()) {
      throw new Error(`[e2e/test-trip] seed failed (${res.status()}): ${await res.text()}`);
    }
  });
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
