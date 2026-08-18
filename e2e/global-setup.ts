/**
 * Runs once before any test. Just waits for the target app (`E2E_BASE_URL`,
 * or the local webServer) to be reachable — robust whether the preview is
 * still warming or the local webServer hasn't finished booting.
 *
 * No seeding happens here: every spec creates its own fresh fixture user
 * and seeds that user's fixture graph via `seedCanonicalFixture()`
 * (e2e/fixtures/test-trip.ts). There is no shared fixture account.
 */

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

export default async function globalSetup() {
  await waitForApp(baseUrl());
}
