import { eq, and, like } from 'drizzle-orm';
import { getDb, schema } from './db';
import { FIXTURE_EMAIL, playwrightName } from './constants';

/**
 * Create a fresh, empty trip owned by the fixture user with
 * onboarding_state='done'. The Penny submit-trip test uses this so it can
 * skip the onboarding wizard and go straight to typing a prompt into the
 * chat composer.
 *
 * The trip name is prefixed with `playwright-<runId>-` so the cleanup
 * teardown sweeps it up automatically. Returns the trip id so the test
 * can navigate directly to /trips/<id>.
 */
export async function createBlankPlanningTrip(label: string): Promise<{
  tripId: number;
  name: string;
}> {
  const db = getDb();

  const userRow = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1)
  )[0];
  if (!userRow) {
    throw new Error(
      `[e2e/test-trip] Fixture user ${FIXTURE_EMAIL} not found. ` +
        'Did global setup run? Try `npm run e2e:seed`.',
    );
  }

  // Prefer the fixture vehicle so Penny has a real refill_distance_km
  // value and the auto fuel planner does interesting work mid-test.
  const vehicleRow = (
    await db
      .select({ id: schema.vehicles.id })
      .from(schema.vehicles)
      .where(
        and(
          eq(schema.vehicles.userId, userRow.id),
          eq(schema.vehicles.isDefault, true),
        ),
      )
      .limit(1)
  )[0];

  const name = playwrightName(label);
  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: vehicleRow?.id ?? null,
      name,
      status: 'planning',
      onboardingState: 'done',
    })
    .returning({ id: schema.trips.id });

  return { tripId: trip.id, name };
}

/** Count the legs currently attached to a trip (post-Penny submit assertion). */
export async function countLegs(tripId: number): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.legs.id })
    .from(schema.legs)
    .where(eq(schema.legs.tripId, tripId));
  return rows.length;
}

/**
 * Scrub all playwright-* trips for the fixture user. Useful inside a
 * single-test cleanup when you want to reset state mid-suite without
 * waiting for globalTeardown.
 */
export async function deleteFixtureUserPlaywrightTrips(): Promise<void> {
  const db = getDb();
  const user = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1)
  )[0];
  if (!user) return;

  await db
    .delete(schema.trips)
    .where(
      and(eq(schema.trips.userId, user.id), like(schema.trips.name, 'playwright-%')),
    );
}
