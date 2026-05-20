/**
 * Read-only remediation diagnosis for one user email (DATABASE_URL required).
 *
 * Prints:
 * - users row id + persisted needs_vehicle_profile_remediation flag
 * - OAuth account rows (helps spot duplicate identities)
 * - Each owned vehicle mapped for `vehicleIsCompleteForRemediation`
 * - Whether SSR would gate /trips (empty garage OR any incomplete vehicle)
 *
 * Usage:
 *   npx tsx scripts/remediation-diagnose.ts "you@example.com"
 *
 * For authenticated JSON (`/api/me/vehicle-remediation`), run `npm run smoke-api`
 * with SMOKE_COOKIE set (see comment at top of `scripts/smoke-api.ts`).
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, asc, sql } from 'drizzle-orm';
import { users, vehicles, accounts } from '@/server/db/schema';
import { vehicleIsCompleteForRemediation } from '@/lib/vehicleProfile';

function vehicleRowToRemediationRecord(row: typeof vehicles.$inferSelect): Record<string, unknown> {
  return {
    name: row.name,
    refill_distance_km: row.refillDistanceKm,
    max_drive_hours_per_day: row.maxDriveHoursPerDay,
    max_drive_hours_per_week: row.maxDriveHoursPerWeek,
    max_consecutive_drive_days: row.maxConsecutiveDriveDays,
    dump_station_interval_days: row.dumpStationIntervalDays,
    dump_station_tracking_enabled: row.dumpStationTrackingEnabled,
  };
}

async function main() {
  const raw = process.argv[2]?.trim();
  const emailNorm = raw?.toLowerCase();
  if (!emailNorm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
    console.error('Usage: npx tsx scripts/remediation-diagnose.ts "<email>"');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (.env)');
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    const userRows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${emailNorm}`)
      .limit(2);
    if (userRows.length === 0) {
      console.log(`No users row with email = ${JSON.stringify(emailNorm)}`);
      return;
    }
    if (userRows.length > 1) {
      console.warn('WARN: Multiple users rows share this email (unexpected schema state). Picking first.');
    }
    const u = userRows[0];

    console.log('\n=== User ===');
    console.log(
      JSON.stringify(
        {
          id: u.id,
          email: u.email,
          needs_vehicle_profile_remediation_DB: u.needsVehicleProfileRemediation,
        },
        null,
        2
      ),
    );

    const accRows = await db.select().from(accounts).where(eq(accounts.userId, u.id));
    console.log(`\n=== OAuth accounts (${accRows.length}) ===`);
    console.log(
      JSON.stringify(
        accRows.map((a) => ({
          provider: a.provider,
          providerAccountId: a.providerAccountId,
        })),
        null,
        2,
      ),
    );

    const vehRows = await db
      .select()
      .from(vehicles)
      .where(eq(vehicles.userId, u.id))
      .orderBy(asc(vehicles.id));
    console.log(`\n=== Vehicles (${vehRows.length}) ===`);

    let anyIncomplete = false;
    for (const row of vehRows) {
      const mapped = vehicleRowToRemediationRecord(row);
      const complete = vehicleIsCompleteForRemediation(mapped);
      if (!complete) anyIncomplete = true;
      console.log(
        `- id=${row.id} name=${JSON.stringify(row.name)} complete_for_remediation=${complete}`,
      );
      if (!complete) {
        console.log(`  snapshot: ${JSON.stringify(mapped)}`);
      }
    }

    const wouldGateSSR = vehRows.length === 0 || anyIncomplete;
    console.log('\n=== Gate preview (SSR /trips) ===');
    console.log(`garage_empty: ${vehRows.length === 0}`);
    console.log(`any_incomplete_vehicle: ${vehRows.length > 0 ? anyIncomplete : 'n/a'}`);
    console.log(`would_gate_remediation_overlay: ${wouldGateSSR}`);
    console.log(
      '\nAPI check (authenticated): `npm run smoke-api` with SMOKE_COOKIE — prints `/api/me/vehicle-remediation` JSON.\n',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
