/**
 * Seed (or refresh) the public Iberia → Nordkapp demo trip in Postgres.
 *
 *   - Creates a system user (demo@trip-planner.local) if missing.
 *   - Marks the demo trip with is_template=true so any signed-in user can clone it.
 *   - Idempotent: re-running deletes the previous demo trip and rebuilds it.
 *
 * Usage:  npm run seed
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { DEMO_TRIP, DEMO_LEGS } from '../src/data/demo-trip';

const DEMO_EMAIL = 'demo@trip-planner.local';
const DEMO_NAME = 'Trip Planner Demo';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before seeding.');
  }
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    let demoUser = (
      await db.select().from(schema.users).where(eq(schema.users.email, DEMO_EMAIL)).limit(1)
    )[0];

    if (!demoUser) {
      const [created] = await db
        .insert(schema.users)
        .values({ email: DEMO_EMAIL, name: DEMO_NAME })
        .returning();
      demoUser = created;
      console.log(`Created demo user ${created.id}`);
    } else {
      console.log(`Reusing demo user ${demoUser.id}`);
    }

    const existingDemo = await db
      .select({ id: schema.trips.id })
      .from(schema.trips)
      .where(eq(schema.trips.userId, demoUser.id));
    for (const t of existingDemo) {
      await db.delete(schema.trips).where(eq(schema.trips.id, t.id));
      console.log(`Deleted previous demo trip #${t.id}`);
    }

    const [trip] = await db
      .insert(schema.trips)
      .values({
        userId: demoUser.id,
        name: DEMO_TRIP.name,
        startDate: DEMO_TRIP.start_date,
        // start_date_parsed is non-null; the demo's start_date is already ISO.
        startDateParsed: DEMO_TRIP.start_date,
        endDate: DEMO_TRIP.end_date,
        endDateParsed: DEMO_TRIP.end_date,
        status: DEMO_TRIP.status,
        isTemplate: true,
      })
      .returning();
    console.log(`Created demo trip #${trip.id}: ${trip.name}`);

    for (const leg of DEMO_LEGS) {
      const [insertedLeg] = await db
        .insert(schema.legs)
        .values({
          tripId: trip.id,
          sortOrder: leg.sort_order,
          title: leg.title,
          label: leg.label,
          startName: leg.start_name,
          endName: leg.end_name,
          startLat: leg.start_lat,
          startLng: leg.start_lng,
          endLat: leg.end_lat,
          endLng: leg.end_lng,
          dates: leg.dates,
          distanceKm: leg.distance_km,
          driveTimeMinutes: leg.drive_time_minutes,
          terrain: leg.terrain,
          overnight: leg.overnight,
          status: leg.status,
          color: leg.color,
          notes: JSON.stringify(leg.notes),
        })
        .returning();

      if (leg.costs?.length) {
        await db.insert(schema.costs).values(
          leg.costs.map((c) => ({
            legId: insertedLeg.id,
            item: c.item,
            estimate: c.est,
            isTotal: !!c.isTotal,
          }))
        );
      }

      if (leg.links?.length) {
        await db.insert(schema.links).values(
          leg.links.map((l) => ({
            legId: insertedLeg.id,
            label: l.label,
            url: l.url,
            type: l.type,
          }))
        );

        // Mirror map/booking links into a single default route, so the new
        // ROUTES section is populated for the demo without manual migration.
        const routeLinks = leg.links.filter((l) => /maps|booking|gpx|wikiloc|komoot|gaia/i.test(l.type));
        if (routeLinks.length > 0) {
          const [defaultRoute] = await db
            .insert(schema.routes)
            .values({
              legId: insertedLeg.id,
              sortOrder: 0,
              label: 'Suggested route',
              status: 'selected',
            })
            .returning();
          await db.insert(schema.routeLinks).values(
            routeLinks.map((l) => ({
              routeId: defaultRoute.id,
              label: l.label,
              url: l.url,
              type:
                l.type === 'maps'
                  ? 'google_maps'
                  : l.type === 'booking'
                    ? 'other'
                    : l.type,
            }))
          );
        }
      }
    }

    console.log(`Seeded ${DEMO_LEGS.length} legs.`);
    console.log('Done. Sign in to the app and clone the demo trip from /trips.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
