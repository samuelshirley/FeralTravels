import { eq, and, like } from 'drizzle-orm';
import { getDb, schema, withDbRetry } from './db';
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
  tripId: string;
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

/**
 * Trip that has not run onboarding yet (`not_started`). The first GET to
 * `/api/trips/:id/onboarding` bumps the row to `trip_intent` and shows
 * Penny's greeting — the wizard then walks through trip_intent → units_pick
 * → vehicle setup. There is no trip-naming step (Penny names the trip from
 * its route during planning). No Anthropic calls needed.
 */
export async function createOnboardingTrip(label: string): Promise<{
  tripId: string;
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

  const name = playwrightName(label);
  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: null,
      name,
      status: 'planning',
      onboardingState: 'not_started',
    })
    .returning({ id: schema.trips.id });

  return { tripId: trip.id, name };
}

/**
 * Trip fixed in `vehicle_new` with an intentionally incomplete vehicle profile
 * (refill + driving limits unset). Skips units/vehicle pick — for exercising
 * numeric validation in the chat composer onboarding path.
 */
export async function createVehicleNewProfileTrip(label: string): Promise<{
  tripId: string;
  vehicleId: string;
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

  const name = playwrightName(label);
  const [vehicle] = await db
    .insert(schema.vehicles)
    .values({
      userId: userRow.id,
      name: `${name} vehicle`,
      isDefault: false,
      refillDistanceKm: null,
      maxDriveHoursPerDay: null,
      maxDriveHoursPerWeek: null,
      maxConsecutiveDriveDays: null,
      dumpStationIntervalDays: null,
      dumpStationTrackingEnabled: null,
    })
    .returning({ id: schema.vehicles.id });

  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: vehicle.id,
      name,
      status: 'planning',
      onboardingState: 'vehicle_new',
    })
    .returning({ id: schema.trips.id });

  return { tripId: trip.id, vehicleId: vehicle.id, name };
}

/**
 * Remove the extra vehicle + trip created by {@link createVehicleNewProfileTrip}.
 * Deletes the trip first (FK from trip → vehicle is on delete set null; trip
 * cascades legs/chat), then the ad-hoc vehicle so later specs still see exactly
 * one vehicle on {@link FIXTURE_EMAIL}.
 */
export async function deleteVehicleNewProfileFixture(opts: {
  tripId: string;
  vehicleId: string;
}): Promise<void> {
  const db = getDb();
  await db.delete(schema.trips).where(eq(schema.trips.id, opts.tripId));
  await db.delete(schema.vehicles).where(eq(schema.vehicles.id, opts.vehicleId));
}

/** Count the legs currently attached to a trip (post-Penny submit assertion). */
export async function countLegs(tripId: string): Promise<number> {
  return withDbRetry(async () => {
    const db = getDb();
    const rows = await db
      .select({ id: schema.legs.id })
      .from(schema.legs)
      .where(eq(schema.legs.tripId, tripId));
    return rows.length;
  });
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
