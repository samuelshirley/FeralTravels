/**
 * Seed (or refresh) the E2E fixture user, default vehicle, and one trip
 * with two pre-built legs. Idempotent — safe to run before every test
 * suite. The fixture is what the "existing user with a trip" tests assert
 * against; the seed is what guarantees the assertions are stable.
 *
 * **Full data wipe (no unique-email "new users"):** After upserting the
 * stable `users` row for `FIXTURE_EMAIL`, we DELETE **all** trips and **all**
 * vehicles owned by that user. That clears chat history, legs, leftover
 * Penny runs, and stray vehicles so the account looks freshly reset while
 * keeping the same auth identity (sessions still work). Then we insert one
 * fresh "E2E Fixture Van" and "E2E Fixture Trip" from scratch.
 *
 * What it creates / re-asserts:
 *   - users row with email = E2E_FIXTURE_EMAIL (default
 *     feral-e2e-fixture@feraltravels.test), emailVerified set so the OTP
 *     guard never re-prompts.
 *   - vehicles row "E2E Fixture Van" marked as default, with **every field
 *     required by `vehicleIsCompleteForRemediation` (see src/lib/vehicleProfile.ts)
 *     so the trip workspace never shows the vehicle remediation overlay in E2E.
 *   - trips row "E2E Fixture Trip" with onboarding_state='done' (so the
 *     workspace shows the chat composer, not the onboarding form), and two
 *     legs (Day 1 + Day 2) with real coordinates so the map renders dots.
 *
 * Teardown (`cleanup-e2e.ts`) still deletes `playwright-*` rows after a suite;
 * that catches anything created mid-run before the next globalSetup wipe.
 *
 * Usage:
 *   npm run e2e:seed
 *   (or implicitly from playwright globalSetup)
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, schema } from '../e2e/fixtures/db';
import {
  FIXTURE_EMAIL,
  FIXTURE_USER_NAME,
  FIXTURE_TRIP_NAME,
  FIXTURE_VEHICLE_NAME,
} from '../e2e/fixtures/constants';

async function main() {
  const db = getDb();

  // --- 1. Upsert the fixture user --------------------------------------
  let userRow = (
    await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, FIXTURE_EMAIL))
      .limit(1)
  )[0];

  if (!userRow) {
    [userRow] = await db
      .insert(schema.users)
      .values({
        email: FIXTURE_EMAIL,
        name: FIXTURE_USER_NAME,
        emailVerified: new Date(),
      })
      .returning();
    console.log(`[seed-e2e] Created fixture user ${userRow.id}`);
  } else if (!userRow.emailVerified) {
    // The Auth.js admin guard requires emailVerified to be set. Backfill
    // it on existing rows so re-running the seed self-heals.
    await db
      .update(schema.users)
      .set({ emailVerified: new Date() })
      .where(eq(schema.users.id, userRow.id));
    console.log(`[seed-e2e] Backfilled emailVerified on fixture user ${userRow.id}`);
  } else {
    console.log(`[seed-e2e] Reusing fixture user ${userRow.id}`);
  }

  // --- 2. Wipe all trips + vehicles for this user (fresh account, same email) --
  // Deletes every trip (cascades legs, chat, stops, …) and every vehicle so
  // we don't accumulate Penny runs, extra vans, or mutated fixture data.
  // The users row + Auth sessions stay — no need to mint unique emails.
  const deletedTrips = await db
    .delete(schema.trips)
    .where(eq(schema.trips.userId, userRow.id))
    .returning({ id: schema.trips.id });
  if (deletedTrips.length) {
    console.log(`[seed-e2e] Deleted ${deletedTrips.length} trip(s) for fixture user.`);
  }

  const deletedVehicles = await db
    .delete(schema.vehicles)
    .where(eq(schema.vehicles.userId, userRow.id))
    .returning({ id: schema.vehicles.id });
  if (deletedVehicles.length) {
    console.log(`[seed-e2e] Deleted ${deletedVehicles.length} vehicle(s) for fixture user.`);
  }

  await db
    .delete(schema.userViewportTime)
    .where(eq(schema.userViewportTime.userId, userRow.id));

  await db
    .update(schema.users)
    .set({
      unitsPref: null,
      needsVehicleProfileRemediation: false,
    })
    .where(eq(schema.users.id, userRow.id));

  // --- 3. Create default vehicle -------------------------------------------
  const [vehicleRow] = await db
    .insert(schema.vehicles)
    .values({
      userId: userRow.id,
      name: FIXTURE_VEHICLE_NAME,
      isDefault: true,
      refillDistanceKm: 400,
      maxDriveHoursPerDay: 6,
      maxDriveHoursPerWeek: 30,
      maxConsecutiveDriveDays: 5,
      waterRefillDays: 3,
      blackwaterRefillDays: 5,
      waterTrackingEnabled: true,
    })
    .returning();
  console.log(`[seed-e2e] Created fixture vehicle ${vehicleRow.id}`);

  // --- 4. Create fixture trip + legs --------------------------------------
  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: vehicleRow.id,
      name: FIXTURE_TRIP_NAME,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      status: 'planning',
      // Skip the onboarding wizard entirely — tests want to land in the
      // workspace and assert against legs immediately.
      onboardingState: 'done',
    })
    .returning();
  console.log(`[seed-e2e] Created fixture trip #${trip.id}: ${trip.name}`);

  // Two legs across France/Germany so the map has real dots to render
  // and the itinerary list has more than one card to assert on.
  const legSeed = [
    {
      sortOrder: 0,
      title: 'Paris → Strasbourg',
      label: 'Day 1',
      startName: 'Paris, France',
      endName: 'Strasbourg, France',
      startLat: 48.8566,
      startLng: 2.3522,
      endLat: 48.5734,
      endLng: 7.7521,
      dates: '2026-06-01',
      distanceKm: 489,
      driveTimeMinutes: 295,
      terrain: 'Highway, mostly A-roads',
      overnight: 'Strasbourg city campsite',
      status: 'planning',
      color: '#4E7AB0',
    },
    {
      sortOrder: 1,
      title: 'Strasbourg → Stuttgart',
      label: 'Day 2',
      startName: 'Strasbourg, France',
      endName: 'Stuttgart, Germany',
      startLat: 48.5734,
      startLng: 7.7521,
      endLat: 48.7758,
      endLng: 9.1829,
      dates: '2026-06-02',
      distanceKm: 156,
      driveTimeMinutes: 105,
      terrain: 'Autobahn',
      overnight: 'Stuttgart Stellplatz',
      status: 'planning',
      color: '#4A8B7A',
    },
  ];

  for (const seed of legSeed) {
    await db.insert(schema.legs).values({ tripId: trip.id, ...seed });
  }
  console.log(`[seed-e2e] Inserted ${legSeed.length} legs for fixture trip.`);

  console.log('[seed-e2e] Done.');
}

main()
  .catch((err) => {
    console.error('[seed-e2e] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
