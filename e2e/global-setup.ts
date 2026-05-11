/**
 * Runs once before any test. Two responsibilities:
 *
 *   1. Sanity-check the env. Tests will fail in confusing ways if
 *      DATABASE_URL is missing — fail loud here instead.
 *   2. Idempotently re-seed the fixture user + their trip + a default
 *      vehicle. This is what the "existing user with a trip" tests assert
 *      against. Re-running is a no-op when nothing has changed; if a test
 *      mutated fixture data (it shouldn't, but…) we put it back.
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
