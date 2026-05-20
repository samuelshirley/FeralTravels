/**
 * Seed (or refresh) E2E persona users and their canonical trips.
 *
 * **Primary fixture** (`FIXTURE_EMAIL`): default planner — complete vehicle +
 * "E2E Fixture Trip" with two legs (map + itinerary smoke tests).
 *
 * **Remediation persona** (`REMEDIATION_FIXTURE_EMAIL`): separate user with
 * one intentionally incomplete vehicle + "E2E Remediation Trip" so vehicle
 * remediation specs never depend on dynamic trip IDs bolted onto the primary
 * account.
 *
 * Idempotent — safe to run before every test suite via globalSetup.
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
  REMEDIATION_FIXTURE_EMAIL,
  REMEDIATION_USER_NAME,
  REMEDIATION_TRIP_NAME,
  REMEDIATION_VEHICLE_NAME,
} from '../e2e/fixtures/constants';

/** Two legs across France/Germany — shared shape for both persona trips. */
const CANONICAL_TWO_LEGS = [
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
    status: 'planning' as const,
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
    status: 'planning' as const,
    color: '#4A8B7A',
  },
];

async function insertTwoLegs(db: ReturnType<typeof getDb>, tripId: string) {
  for (const seed of CANONICAL_TWO_LEGS) {
    await db.insert(schema.legs).values({ tripId, ...seed });
  }
}

async function seedPrimaryPlannerPersona(db: ReturnType<typeof getDb>) {
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
    await db
      .update(schema.users)
      .set({ emailVerified: new Date() })
      .where(eq(schema.users.id, userRow.id));
    console.log(`[seed-e2e] Backfilled emailVerified on fixture user ${userRow.id}`);
  } else {
    console.log(`[seed-e2e] Reusing fixture user ${userRow.id}`);
  }

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

  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: vehicleRow.id,
      name: FIXTURE_TRIP_NAME,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      status: 'planning',
      onboardingState: 'done',
    })
    .returning();
  console.log(`[seed-e2e] Created fixture trip #${trip.id}: ${trip.name}`);

  await insertTwoLegs(db, trip.id);
  console.log(`[seed-e2e] Inserted ${CANONICAL_TWO_LEGS.length} legs for fixture trip.`);
}

/**
 * Incomplete vehicle (strict-driving fields null) + remediation flag so
 * /trips redirects into the workspace chat remediation flow.
 */
async function seedRemediationPersona(db: ReturnType<typeof getDb>) {
  let userRow = (
    await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, REMEDIATION_FIXTURE_EMAIL))
      .limit(1)
  )[0];

  if (!userRow) {
    [userRow] = await db
      .insert(schema.users)
      .values({
        email: REMEDIATION_FIXTURE_EMAIL,
        name: REMEDIATION_USER_NAME,
        emailVerified: new Date(),
      })
      .returning();
    console.log(`[seed-e2e] Created remediation persona user ${userRow.id}`);
  } else if (!userRow.emailVerified) {
    await db
      .update(schema.users)
      .set({ emailVerified: new Date() })
      .where(eq(schema.users.id, userRow.id));
    console.log(`[seed-e2e] Backfilled emailVerified on remediation user ${userRow.id}`);
  } else {
    console.log(`[seed-e2e] Reusing remediation persona user ${userRow.id}`);
  }

  const deletedTrips = await db
    .delete(schema.trips)
    .where(eq(schema.trips.userId, userRow.id))
    .returning({ id: schema.trips.id });
  if (deletedTrips.length) {
    console.log(`[seed-e2e] Deleted ${deletedTrips.length} trip(s) for remediation persona.`);
  }

  const deletedVehicles = await db
    .delete(schema.vehicles)
    .where(eq(schema.vehicles.userId, userRow.id))
    .returning({ id: schema.vehicles.id });
  if (deletedVehicles.length) {
    console.log(`[seed-e2e] Deleted ${deletedVehicles.length} vehicle(s) for remediation persona.`);
  }

  await db
    .delete(schema.userViewportTime)
    .where(eq(schema.userViewportTime.userId, userRow.id));

  await db
    .update(schema.users)
    .set({
      unitsPref: null,
      needsVehicleProfileRemediation: true,
    })
    .where(eq(schema.users.id, userRow.id));

  const [vehicleRow] = await db
    .insert(schema.vehicles)
    .values({
      userId: userRow.id,
      name: REMEDIATION_VEHICLE_NAME,
      isDefault: true,
      refillDistanceKm: 400,
      maxDriveHoursPerDay: null,
      maxDriveHoursPerWeek: null,
      maxConsecutiveDriveDays: null,
      waterRefillDays: null,
      blackwaterRefillDays: null,
      waterTrackingEnabled: null,
    })
    .returning();
  console.log(`[seed-e2e] Created remediation vehicle ${vehicleRow.id} (incomplete profile)`);

  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: vehicleRow.id,
      name: REMEDIATION_TRIP_NAME,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      status: 'planning',
      onboardingState: 'done',
    })
    .returning();
  console.log(`[seed-e2e] Created remediation trip #${trip.id}: ${trip.name}`);

  await insertTwoLegs(db, trip.id);
  console.log(`[seed-e2e] Inserted ${CANONICAL_TWO_LEGS.length} legs for remediation trip.`);
}

async function main() {
  const db = getDb();
  await seedPrimaryPlannerPersona(db);
  await seedRemediationPersona(db);
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
