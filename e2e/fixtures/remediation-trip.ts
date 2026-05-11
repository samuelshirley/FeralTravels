import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';
import { FIXTURE_EMAIL, playwrightName } from './constants';

/**
 * Trip + disposable vehicle for remediation e2e — strict driving gaps with
 * sane refill so the row can attach to a planning trip.
 */
export async function createRemediationPlaywrightTrip(label: string): Promise<{
  tripId: number;
  vehicleId: number;
  userId: string;
  tripName: string;
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
      `[e2e/remediation-trip] Fixture user ${FIXTURE_EMAIL} not found. ` +
        'Did global setup run? Try `npm run e2e:seed`.',
    );
  }

  const vehicleName = playwrightName(`${label}-Rig`);
  const [v] = await db
    .insert(schema.vehicles)
    .values({
      userId: userRow.id,
      name: vehicleName,
      isDefault: false,
      refillDistanceKm: 400,
    })
    .returning({ id: schema.vehicles.id });

  await db
    .update(schema.users)
    .set({ needsVehicleProfileRemediation: true })
    .where(eq(schema.users.id, userRow.id));

  const tripName = playwrightName(label);
  const [trip] = await db
    .insert(schema.trips)
    .values({
      userId: userRow.id,
      vehicleId: v.id,
      name: tripName,
      status: 'planning',
      onboardingState: 'done',
    })
    .returning({ id: schema.trips.id });

  return {
    tripId: trip.id,
    vehicleId: v.id,
    userId: userRow.id,
    tripName,
  };
}

export async function deleteRemediationPlaywrightFixture(opts: {
  tripId: number;
  vehicleId: number;
  userId: string;
}): Promise<void> {
  const db = getDb();
  await db.delete(schema.trips).where(eq(schema.trips.id, opts.tripId));
  await db.delete(schema.vehicles).where(eq(schema.vehicles.id, opts.vehicleId));
  await db
    .update(schema.users)
    .set({ needsVehicleProfileRemediation: false })
    .where(eq(schema.users.id, opts.userId));
}
