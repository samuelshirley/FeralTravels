/**
 * One-time migration from the legacy local SQLite database to Postgres (Neon).
 *
 * Usage:  npm run migrate-sqlite -- [--sqlite=/tmp/trip-planner/trip.db] [--owner-email=you@example.com]
 *
 * Behaviour:
 *   - Imports the (single) legacy trip into Postgres under the supplied
 *     `--owner-email` user (must already exist in the new auth tables).
 *   - If `--owner-email` is omitted, falls back to the demo user
 *     (demo@trip-planner.local) and marks the trip as a template.
 *   - Idempotent: writes a marker into app_meta so re-running is a no-op.
 */
import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'];
    })
);

const SQLITE_PATH = (args.sqlite as string) || process.env.DB_PATH || '/tmp/trip-planner/trip.db';
const OWNER_EMAIL = (args['owner-email'] as string) || 'demo@trip-planner.local';
const MIGRATION_KEY = `sqlite-import:${path.basename(SQLITE_PATH)}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }
  console.log(`Reading SQLite db: ${SQLITE_PATH}`);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  const pg = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(pg, { schema });

  try {
    const already = (
      await db
        .select({ value: schema.appMeta.value })
        .from(schema.appMeta)
        .where(eq(schema.appMeta.key, MIGRATION_KEY))
        .limit(1)
    )[0];
    if (already) {
      console.log(`Already imported (${MIGRATION_KEY} = ${already.value}). Nothing to do.`);
      return;
    }

    let owner = (
      await db.select().from(schema.users).where(eq(schema.users.email, OWNER_EMAIL)).limit(1)
    )[0];
    let isTemplate = false;
    if (!owner) {
      console.log(`User ${OWNER_EMAIL} not found, creating system demo user…`);
      const [created] = await db
        .insert(schema.users)
        .values({ email: OWNER_EMAIL, name: 'Trip Planner Demo' })
        .returning();
      owner = created;
      isTemplate = true;
    } else if (OWNER_EMAIL === 'demo@trip-planner.local') {
      isTemplate = true;
    }

    const trips = sqlite.prepare('SELECT * FROM trips').all() as any[];
    if (trips.length === 0) {
      console.log('No trips in SQLite. Nothing to migrate.');
      return;
    }

    for (const t of trips) {
      const [newTrip] = await db
        .insert(schema.trips)
        .values({
          userId: owner.id,
          name: t.name,
          startDate: t.start_date,
          endDate: t.end_date,
          status: t.status ?? 'planning',
          isTemplate,
        })
        .returning();
      console.log(`Imported trip "${t.name}" -> #${newTrip.id} (template=${isTemplate})`);

      const legs = sqlite.prepare('SELECT * FROM legs WHERE trip_id = ? ORDER BY sort_order').all(t.id) as any[];
      const legIdMap = new Map<number, number>();
      for (const l of legs) {
        const [nl] = await db
          .insert(schema.legs)
          .values({
            tripId: newTrip.id,
            sortOrder: l.sort_order,
            title: l.title,
            label: l.label,
            startName: l.start_name,
            endName: l.end_name,
            startLat: l.start_lat,
            startLng: l.start_lng,
            endLat: l.end_lat,
            endLng: l.end_lng,
            dates: l.dates,
            distanceKm: l.distance_km,
            driveTimeMinutes: l.drive_time_minutes,
            terrain: l.terrain,
            overnight: l.overnight,
            status: l.status ?? 'planning',
            color: l.color,
            notes: l.notes,
          })
          .returning();
        legIdMap.set(l.id, nl.id);
      }

      const copyTable = async (sql: string, build: (row: any, newLegId: number) => any, table: any) => {
        const rows = sqlite.prepare(sql).all(t.id) as any[];
        for (const row of rows) {
          const newLegId = legIdMap.get(row.leg_id);
          if (!newLegId) continue;
          await db.insert(table).values(build(row, newLegId));
        }
      };

      await copyTable(
        'SELECT c.* FROM costs c JOIN legs l ON c.leg_id = l.id WHERE l.trip_id = ?',
        (c, legId) => ({
          legId,
          item: c.item,
          estimate: c.estimate,
          isTotal: !!c.is_total,
        }),
        schema.costs
      );

      await copyTable(
        'SELECT lk.* FROM links lk JOIN legs l ON lk.leg_id = l.id WHERE l.trip_id = ?',
        (lk, legId) => ({ legId, label: lk.label, url: lk.url, type: lk.type ?? 'general' }),
        schema.links
      );

      const sqlRoutes = sqlite
        .prepare('SELECT r.* FROM routes r JOIN legs l ON r.leg_id = l.id WHERE l.trip_id = ?')
        .all(t.id) as any[];
      const routeIdMap = new Map<number, number>();
      for (const r of sqlRoutes) {
        const newLegId = legIdMap.get(r.leg_id);
        if (!newLegId) continue;
        const [nr] = await db
          .insert(schema.routes)
          .values({
            legId: newLegId,
            sortOrder: r.sort_order ?? 0,
            label: r.label,
            description: r.description,
            distanceKm: r.distance_km,
            surface: r.surface,
            status: r.status ?? 'option',
            gpxTrailId: null,
          })
          .returning();
        routeIdMap.set(r.id, nr.id);
      }

      const sqlRouteLinks = sqlite
        .prepare(
          'SELECT rl.* FROM route_links rl JOIN routes r ON rl.route_id = r.id JOIN legs l ON r.leg_id = l.id WHERE l.trip_id = ?'
        )
        .all(t.id) as any[];
      for (const rl of sqlRouteLinks) {
        const newRouteId = routeIdMap.get(rl.route_id);
        if (!newRouteId) continue;
        await db.insert(schema.routeLinks).values({
          routeId: newRouteId,
          label: rl.label,
          url: rl.url,
          type: rl.type ?? 'other',
        });
      }

      const sqlTasks = sqlite.prepare('SELECT * FROM tasks WHERE trip_id = ?').all(t.id) as any[];
      for (const task of sqlTasks) {
        const newLegId = task.leg_id ? legIdMap.get(task.leg_id) ?? null : null;
        await db.insert(schema.tasks).values({
          tripId: newTrip.id,
          legId: newLegId,
          title: task.title,
          description: task.description,
          priority: task.priority ?? 'normal',
          status: task.status ?? 'open',
          referenceUrl: task.reference_url,
          referenceLabel: task.reference_label,
          referencePhone: task.reference_phone,
          answer: task.answer,
          answerSourceUrl: task.answer_source_url,
          answerImageUrl: task.answer_image_url,
          createdBy: task.created_by ?? 'user',
          dueAt: task.due_at ? new Date(task.due_at) : null,
        });
      }

      const sqlPois = sqlite.prepare('SELECT * FROM pois WHERE trip_id = ?').all(t.id) as any[];
      for (const p of sqlPois) {
        const newLegId = p.leg_id ? legIdMap.get(p.leg_id) ?? null : null;
        await db.insert(schema.pois).values({
          tripId: newTrip.id,
          legId: newLegId,
          source: p.source,
          externalId: p.external_id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          type: p.type,
          description: p.description,
          rating: p.rating,
          url: p.url,
          data: p.data,
          status: p.status ?? 'active',
        });
      }
    }

    await db
      .insert(schema.appMeta)
      .values({ key: MIGRATION_KEY, value: new Date().toISOString() })
      .onConflictDoUpdate({ target: schema.appMeta.key, set: { value: new Date().toISOString() } });
    console.log('Migration complete.');
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
