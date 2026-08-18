/**
 * Runs once after all tests. With a fresh fixture user per test there is
 * no shared persona to sweep — each spec that creates ad-hoc rows cleans them
 * up itself via `/api/test/cleanup` (see cleanupPlaywrightFixtureData). On CI
 * the whole database branch is ephemeral and re-cloned from prod on the next
 * push anyway.
 */
export default async function globalTeardown() {
  if (process.env.E2E_KEEP_DATA === '1') {
    console.log('[e2e] E2E_KEEP_DATA=1 — leaving test rows in place.');
  }
}
