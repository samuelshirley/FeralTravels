/**
 * Runs once before any test. Seeds both E2E personas over HTTP against the
 * target app (`E2E_BASE_URL`, or the local webServer) via the guarded
 * `/api/test/seed` endpoint — no direct database access. Each call resets that
 * persona's graph and recreates the canonical vehicle + trip + two legs.
 *
 * Because seeding is HTTP now, the app must be reachable; we poll for it first
 * so this is robust whether the preview is still warming or the local webServer
 * hasn't finished booting. The endpoint only exists when AUTH_TEST_BACKDOOR is
 * configured on the target (off on real prod).
 */
import {
  FIXTURE_EMAIL,
  FIXTURE_USER_NAME,
  FIXTURE_TRIP_NAME,
  FIXTURE_VEHICLE_NAME,
} from './fixtures/constants';

function baseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function waitForApp(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status > 0) return; // any HTTP response means the server is up
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`[e2e] Target app never became reachable at ${url} (${lastErr})`);
}

async function seedPersona(p: {
  email: string;
  userName: string;
  vehicleName: string;
  tripName: string;
}): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/test/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (!res.ok) {
    throw new Error(
      `[e2e] Seed failed (${res.status}) for ${p.email}: ${await res.text()}. ` +
        'Is AUTH_TEST_BACKDOOR configured on the target app?',
    );
  }
}

export default async function globalSetup() {
  await waitForApp(baseUrl());
  await seedPersona({
    email: FIXTURE_EMAIL,
    userName: FIXTURE_USER_NAME,
    vehicleName: FIXTURE_VEHICLE_NAME,
    tripName: FIXTURE_TRIP_NAME,
  });
}
