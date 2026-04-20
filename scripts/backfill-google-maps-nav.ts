/**
 * One-time (idempotent) backfill that rewrites every `route_links` row of
 * `type='google_maps'` so its URL launches Google Maps in turn-by-turn
 * navigation mode (`dir_action=navigate` on the API-style directions URL).
 *
 * Why: Penny historically saved path-style URLs (`/maps/dir/Girona/Genoa`).
 * On mobile Google Maps cannot mix path-style + `?api=1`, so tapping "Go"
 * navigated only to the first segment ("Girona") instead of the full leg.
 * `rewriteMapsUrlForNav` now rebuilds path-style URLs from the leg's coords;
 * this script applies that same rewrite to existing rows.
 *
 * Usage:  npm run backfill-maps-nav            # against $DATABASE_URL
 *         npm run backfill-maps-nav -- --dry   # report only, no writes
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { rewriteMapsUrlForNav, type LegCoords } from '../src/lib/maps';

const DRY = process.argv.includes('--dry');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before running.');
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    // Pull every google_maps route_link plus the leg coords needed to
    // rebuild path-style URLs.
    const rows = await db
      .select({
        linkId: schema.routeLinks.id,
        url: schema.routeLinks.url,
        legId: schema.routes.legId,
        startLat: schema.legs.startLat,
        startLng: schema.legs.startLng,
        endLat: schema.legs.endLat,
        endLng: schema.legs.endLng,
      })
      .from(schema.routeLinks)
      .innerJoin(schema.routes, eq(schema.routeLinks.routeId, schema.routes.id))
      .innerJoin(schema.legs, eq(schema.routes.legId, schema.legs.id))
      .where(eq(schema.routeLinks.type, 'google_maps'));

    let inspected = 0;
    let changed = 0;
    let skippedNoCoords = 0;

    for (const row of rows) {
      inspected++;
      const coords: LegCoords = {
        start_lat: row.startLat,
        start_lng: row.startLng,
        end_lat: row.endLat,
        end_lng: row.endLng,
      };
      const next = rewriteMapsUrlForNav(row.url, coords);
      if (next === row.url) continue;

      // Sanity: don't overwrite with the original if rewriter only echoed
      // back because we lacked coords for a path-style URL.
      if (
        row.endLat == null ||
        row.endLng == null ||
        !Number.isFinite(row.endLat) ||
        !Number.isFinite(row.endLng)
      ) {
        // If the rewriter actually changed the URL despite missing end coords
        // (e.g. the URL was already API-style and just needed dir_action),
        // we still want to apply it. Only skip when the change is null.
        if (next === row.url) {
          skippedNoCoords++;
          continue;
        }
      }

      changed++;
      console.log(
        `[${DRY ? 'dry' : 'write'}] link ${row.linkId} (leg ${row.legId})\n  before: ${row.url}\n  after:  ${next}`
      );
      if (!DRY) {
        await db
          .update(schema.routeLinks)
          .set({ url: next })
          .where(eq(schema.routeLinks.id, row.linkId));
      }
    }

    console.log('');
    console.log(`Inspected: ${inspected}`);
    console.log(`Changed:   ${changed}${DRY ? ' (dry-run, no writes)' : ''}`);
    console.log(`Skipped (no coords + path-style): ${skippedNoCoords}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('backfill-google-maps-nav failed:', err);
  process.exit(1);
});
