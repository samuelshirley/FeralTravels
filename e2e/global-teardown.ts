/**
 * Runs once after all tests, regardless of pass/fail. Sweeps any
 * `playwright-`-prefixed trips/vehicles the suite created, over HTTP via the
 * guarded `/api/test/cleanup` endpoint (no direct DB access). The personas'
 * canonical data is fully reset on the next globalSetup.
 */
import { FIXTURE_EMAIL } from './fixtures/constants';

function baseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function cleanupPersona(email: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/test/cleanup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    console.warn(`[e2e] Cleanup returned ${res.status} for ${email}. Re-run manually if needed.`);
  }
}

export default async function globalTeardown() {
  if (process.env.E2E_KEEP_DATA === '1') {
    console.log('[e2e] E2E_KEEP_DATA=1 — leaving test rows in place.');
    return;
  }
  try {
    await cleanupPersona(FIXTURE_EMAIL);
  } catch (err) {
    // Non-fatal — a failed cleanup shouldn't fail the run.
    console.warn(`[e2e] Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
