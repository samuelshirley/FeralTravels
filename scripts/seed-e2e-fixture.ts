/**
 * Seed (or refresh) the E2E fixture user, default vehicle, and one trip
 * with two pre-built legs. Idempotent — safe to run before every test
 * suite. The fixture is what the "existing user with a trip" tests assert
 * against; the seed is what guarantees the assertions are stable.
 *
 * What it creates / re-asserts:
 *   - users row with email = E2E_FIXTURE_EMAIL (default
 *     feral-e2e-fixture@feraltravels.test), emailVerified set so the OTP
 *     guard never re-prompts.
 *   - vehicles row "E2E Fixture Van" marked as default, with reasonable
 *     defaults so Penny + the auto fuel planner have something to work with.
 *   - trips row "E2E Fixture Trip" with onboarding_state='done' (so the
 *     workspace shows the chat composer, not the onboarding form), and two
 *     legs (Day 1 + Day 2) with real coordinates so the map renders dots.
 *
 * If a previous run left the fixture trip with extra legs/stops added by
 * a test, we DELETE the trip and re-create it from scratch. Vehicles and
 * the user row are left alone (just upserted).
 *
 * Usage:
 *   npm run e2e:seed
 *   (or implicitly from playwright globalSetup)
 */
import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
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

  // E2E onboarding tests expect `units_pick` on new trips. Clear any pref
  // from earlier runs so the fixture user is always "not yet chosen".
  await db
    .update(schema.users)
    .set({ unitsPref: null })
    .where(eq(schema.users.id, userRow.id));

  // --- 2. Ensure default vehicle exists --------------------------------
  let vehicleRow = (
    await db
      .select()
      .from(schema.vehicles)
      .where(
        and(
          eq(schema.vehicles.userId, userRow.id),
          eq(schema.vehicles.name, FIXTURE_VEHICLE_NAME),
        ),
      )
      .limit(1)
  )[0];

  if (!vehicleRow) {
    [vehicleRow] = await db
      .insert(schema.vehicles)
      .values({
        userId: userRow.id,
        name: FIXTURE_VEHICLE_NAME,
        isDefault: true,
        // Sensible defaults so Penny doesn't immediately ask the user to
        // fill these in during onboarding.
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
  } else {
    console.log(`[seed-e2e] Reusing fixture vehicle ${vehicleRow.id}`);
  }

  // --- 3. Re-create the fixture trip from scratch ----------------------
  // Tests can mutate trips (add legs, drag waypoints), so we delete +
  // re-create to guarantee a known starting shape every run. Cascade
  // delete cleans up legs/stops/chat for us.
  const existingTrips = await db
    .select({ id: schema.trips.id })
    .from(schema.trips)
    .where(
      and(
        eq(schema.trips.userId, userRow.id),
        eq(schema.trips.name, FIXTURE_TRIP_NAME),
      ),
    );
  for (const t of existingTrips) {
    await db.delete(schema.trips).where(eq(schema.trips.id, t.id));
    console.log(`[seed-e2e] Deleted previous fixture trip #${t.id}`);
  }

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
