/**
 * Runs once after all tests, regardless of pass/fail. Removes any
 * playwright-prefixed rows the suite created so the developer's Neon DB
 * doesn't accumulate junk between runs. The fixture user + their seeded
 * trip are left untouched — they're recreated idempotently on the next
 * globalSetup anyway.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default async function globalTeardown() {
  // Skip cleanup if the user explicitly wants to inspect leftover rows
  // after a debugging session: `E2E_KEEP_DATA=1 npx playwright test`.
  if (process.env.E2E_KEEP_DATA === '1') {
    console.log('[e2e] E2E_KEEP_DATA=1 — leaving test rows in the DB.');
    return;
  }

  const cleanupScript = path.join(__dirname, '..', 'scripts', 'cleanup-e2e.ts');
  const result = spawnSync('npx', ['tsx', cleanupScript], {
    stdio: 'inherit',
    env: process.env,
  });
  // Non-fatal — a failed cleanup shouldn't fail the test report. We just
  // surface a warning so the developer notices and can re-run cleanup.
  if (result.status !== 0) {
    console.warn(
      `[e2e] Cleanup script returned non-zero (${result.status}). Re-run with: npm run e2e:cleanup`,
    );
  }
}
