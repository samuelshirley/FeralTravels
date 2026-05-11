/**
 * Delete every test-created row from the shared Neon DB after a Playwright
 * suite finishes. Rows whose names start with `playwright-` are removed;
 * cascading FKs sweep legs, stops, chat, etc.
 *
 * The fixture user's **entire** trip + vehicle set is *not* scrubbed here —
 * globalSetup runs `seed-e2e-fixture.ts` before the next suite and wipes
 * all of that user's trips/vehicles then rebuilds the known fixture. This
 * teardown only catches stray `playwright-*` rows created mid-run in case
 * a suite exits before the next globalSetup.
 *
 * What gets removed:
 *   - Any vehicles row whose name starts with `playwright-` (created by
 *     the vehicle CRUD test).
 *   - Any trips row whose name starts with `playwright-` (created by the
 *     "new trip" + Penny submit tests). Cascading FKs sweep the legs,
 *     stops, chat history, etc.
 *   - We do NOT remove ad-hoc users — the tests don't create new user
 *     rows directly. The OTP test may create a user the first time you
 *     sign in with E2E_OTP_EMAIL; that row persists like any normal account.
 *
 * Usage:
 *   npm run e2e:cleanup
 *   (or implicitly from playwright globalTeardown)
 */
import 'dotenv/config';
import { like } from 'drizzle-orm';
import { getDb, closeDb, schema } from '../e2e/fixtures/db';
import { PLAYWRIGHT_NAME_PREFIX } from '../e2e/fixtures/constants';

async function main() {
  const db = getDb();
  const pattern = `${PLAYWRIGHT_NAME_PREFIX}%`;

  const tripsDeleted = await db
    .delete(schema.trips)
    .where(like(schema.trips.name, pattern))
    .returning({ id: schema.trips.id });
  if (tripsDeleted.length) {
    console.log(`[cleanup-e2e] Deleted ${tripsDeleted.length} playwright-* trip(s).`);
  }

  const vehiclesDeleted = await db
    .delete(schema.vehicles)
    .where(like(schema.vehicles.name, pattern))
    .returning({ id: schema.vehicles.id });
  if (vehiclesDeleted.length) {
    console.log(
      `[cleanup-e2e] Deleted ${vehiclesDeleted.length} playwright-* vehicle(s).`,
    );
  }

  if (!tripsDeleted.length && !vehiclesDeleted.length) {
    console.log('[cleanup-e2e] Nothing to clean up.');
  }
}

main()
  .catch((err) => {
    console.error('[cleanup-e2e] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
