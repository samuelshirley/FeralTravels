/**
 * Runs once before any test. Two responsibilities:
 *
 *   1. Sanity-check the env. Tests will fail in confusing ways if
 *      DATABASE_URL is missing — fail loud here instead.
 *   2. Idempotently **wipe all trips + vehicles** for the fixture user, then
 *      seed one canonical "E2E Fixture Trip" + vehicle again. Same Auth
 *      identity every run — no unique signup emails — but app data is reset
 *      like a fresh account (see scripts/seed-e2e-fixture.ts).
 *
 *      The seed may set users.units_pref to NULL (see migration 0011). If the
 *      DB still has NOT NULL on that column, run `npm run db:push` (or
 *      `npm run ship`, which syncs the schema before E2E) so Neon matches
 *      schema.ts before Playwright runs.
 *
 * OTP E2E is optional: it only runs when E2E_OTP_EMAIL is set. Other tests
 * don't depend on it.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default async function globalSetup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      '[e2e] DATABASE_URL is not set. Add it to .env (it is the same one the app uses).',
    );
  }

  const seedScript = path.join(__dirname, '..', 'scripts', 'seed-e2e-fixture.ts');
  const result = spawnSync('npx', ['tsx', seedScript], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `[e2e] Fixture seed script failed (exit ${result.status}). See output above.`,
    );
  }
}
