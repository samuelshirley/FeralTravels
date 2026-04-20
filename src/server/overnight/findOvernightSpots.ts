import 'server-only';
import { db } from '@/server/db/client';
import { overnightSpots } from '@/server/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { logUsageEvent } from '@/server/repos/usage';
import { fetchIoverlanderSpots } from './ioverlander';
import { fetchPark4NightSpots } from './park4night';
import { fetchGooglePlacesSpots } from './google_places';
import type { FindSpotsInput, OvernightSource, OvernightSpot } from './types';

export type { FindSpotsInput, OvernightSource, OvernightSpot } from './types';

const GRID_RES = 0.05; // ~5km grid bucket
const FRESHNESS_HOURS = 24 * 7; // re-poll upstream weekly

function gridKey(v: number) {
  return Math.round(v / GRID_RES) * GRID_RES;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface CachedQueryResult {
  spots: OvernightSpot[];
  fromCache: boolean;
}

/**
 * Fetch spots near a point. Hits all enabled sources in parallel, dedupes,
 * persists to the cache, and returns spots sorted by distance ascending.
 *
 * Caching strategy: we look up by source + (lat_grid, lng_grid). If we have
 * fresh rows (< FRESHNESS_HOURS old) covering the requested grid bucket, we
 * skip the upstream call entirely. Otherwise we fetch and upsert.
 */
export async function findOvernightSpots(input: FindSpotsInput): Promise<OvernightSpot[]> {
  const { lat, lng } = input;
  const radiusKm = Math.max(1, input.radiusKm);
  const perSourceLimit = input.perSourceLimit ?? 25;
  const freeOnly = input.freeOnly !== false;

  // Build the set of grid buckets covered by the radius. Keep it tiny — at
  // typical 30–80km radii this is at most ~9 buckets even at the equator.
  const buckets = bucketsCovering(lat, lng, radiusKm);
  const bucketSql = sql.join(
    buckets.map(
      (b) =>
        sql`(${overnightSpots.latGrid} = ${b.lat} AND ${overnightSpots.lngGrid} = ${b.lng})`
    ),
    sql` OR `
  );

  const cached = await db
    .select()
    .from(overnightSpots)
    .where(sql`(${bucketSql})`);

  const sources: OvernightSource[] = ['ioverlander', 'google_places', 'park4night'];
  const cutoff = Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;
  const freshBySource = new Map<OvernightSource, boolean>();
  for (const s of sources) {
    const rowsForSource = cached.filter((r) => r.source === s);
    if (rowsForSource.length === 0) {
      freshBySource.set(s, false);
      continue;
    }
    const newest = Math.max(...rowsForSource.map((r) => r.fetchedAt.getTime()));
    freshBySource.set(s, newest >= cutoff);
  }

  const fetchTasks: Array<Promise<CachedQueryResult>> = [];
  if (!freshBySource.get('ioverlander')) {
    fetchTasks.push(
      runSource('ioverlander', () =>
        fetchIoverlanderSpots({ lat, lng, radiusKm, perSourceLimit, freeOnly })
      )
    );
  }
  if (!freshBySource.get('google_places')) {
    fetchTasks.push(
      runSource('google_places', () =>
        fetchGooglePlacesSpots({ lat, lng, radiusKm, perSourceLimit, freeOnly })
      )
    );
  }
  if (!freshBySource.get('park4night')) {
    fetchTasks.push(
      runSource('park4night', () =>
        fetchPark4NightSpots({ lat, lng, radiusKm, perSourceLimit, freeOnly })
      )
    );
  }

  const fetchResults = await Promise.all(fetchTasks);
  const fetched = fetchResults.flatMap((r) => r.spots);
  if (fetched.length > 0) await persistSpots(fetched);

  // Reload cache after persistence to merge newly inserted ids.
  const allRows = await db
    .select()
    .from(overnightSpots)
    .where(sql`(${bucketSql})`);

  const spots: OvernightSpot[] = allRows
    .map((r) => ({
      id: r.id,
      source: r.source as OvernightSource,
      sourceId: r.sourceId,
      name: r.name,
      lat: r.lat,
      lng: r.lng,
      category: (r.category ?? 'other') as OvernightSpot['category'],
      isFree: r.isFree,
      description: r.description,
      sourceUrl: r.sourceUrl,
      distanceKm: haversineKm(lat, lng, r.lat, r.lng),
    }))
    .filter((s) => (freeOnly ? s.isFree : true))
    .filter((s) => (s.distanceKm ?? 0) <= radiusKm)
    .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  return spots;
}

async function runSource(
  source: OvernightSource,
  fn: () => Promise<OvernightSpot[]>
): Promise<CachedQueryResult> {
  const start = Date.now();
  try {
    const spots = await fn();
    await logUsageEvent({
      provider: `overnight:${source}`,
      requests: 1,
      success: true,
    }).catch(() => {});
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[overnight/${source}] ${spots.length} spots in ${Date.now() - start}ms`);
    }
    return { spots, fromCache: false };
  } catch (err) {
    console.error(`[overnight/${source}] failed`, err);
    await logUsageEvent({
      provider: `overnight:${source}`,
      requests: 1,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return { spots: [], fromCache: false };
  }
}

async function persistSpots(spots: OvernightSpot[]) {
  const rows = spots
    .filter((s) => s.sourceId != null)
    .map((s) => ({
      source: s.source,
      sourceId: s.sourceId,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      category: s.category,
      isFree: s.isFree,
      description: s.description,
      sourceUrl: s.sourceUrl,
      latGrid: gridKey(s.lat),
      lngGrid: gridKey(s.lng),
    }));
  if (rows.length === 0) return;
  await db
    .insert(overnightSpots)
    .values(rows)
    .onConflictDoUpdate({
      target: [overnightSpots.source, overnightSpots.sourceId],
      set: {
        name: sql`excluded.name`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        category: sql`excluded.category`,
        isFree: sql`excluded.is_free`,
        description: sql`excluded.description`,
        sourceUrl: sql`excluded.source_url`,
        latGrid: sql`excluded.lat_grid`,
        lngGrid: sql`excluded.lng_grid`,
        updatedAt: sql`now()`,
        fetchedAt: sql`now()`,
      },
    })
    .catch((err) => {
      // Don't fail the user request just because we couldn't cache.
      console.error('[overnight] persist failed', err);
    });
}

function bucketsCovering(
  lat: number,
  lng: number,
  radiusKm: number
): Array<{ lat: number; lng: number }> {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
  const minLat = gridKey(lat - dLat);
  const maxLat = gridKey(lat + dLat);
  const minLng = gridKey(lng - dLng);
  const maxLng = gridKey(lng + dLng);
  const out: Array<{ lat: number; lng: number }> = [];
  for (let la = minLat; la <= maxLat + 1e-9; la += GRID_RES) {
    for (let ln = minLng; ln <= maxLng + 1e-9; ln += GRID_RES) {
      out.push({ lat: round(la), lng: round(ln) });
    }
  }
  if (out.length === 0) out.push({ lat: gridKey(lat), lng: gridKey(lng) });
  return out;
}

function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Group spots into a small set of drive-time bands relative to a start point.
 * For the first ship we approximate drive time using an average road speed —
 * good enough for "show me the 3-hour, 5-hour, 6-hour band" presentation.
 *
 * Bands: short (≤3h), medium (3–5h), long (5–7h). Spots outside that window
 * are dropped because they'd violate typical max-drive-time vehicle limits.
 */
export interface BandedSpot extends OvernightSpot {
  band: 'short' | 'medium' | 'long';
  driveTimeMinutes: number;
}

const AVG_DRIVE_KMH = 70;

export function bandSpotsByDriveTime(
  spots: OvernightSpot[],
  fromLat: number,
  fromLng: number,
  bands?: { shortMaxMin?: number; mediumMaxMin?: number; longMaxMin?: number }
): BandedSpot[] {
  const shortMax = bands?.shortMaxMin ?? 180; // 3h
  const mediumMax = bands?.mediumMaxMin ?? 300; // 5h
  const longMax = bands?.longMaxMin ?? 420; // 7h

  return spots
    .map((s) => {
      const km = haversineKm(fromLat, fromLng, s.lat, s.lng) * 1.25; // road detour factor
      const minutes = Math.round((km / AVG_DRIVE_KMH) * 60);
      let band: BandedSpot['band'] | null = null;
      if (minutes <= shortMax) band = 'short';
      else if (minutes <= mediumMax) band = 'medium';
      else if (minutes <= longMax) band = 'long';
      return band == null ? null : ({ ...s, band, driveTimeMinutes: minutes } as BandedSpot);
    })
    .filter((s): s is BandedSpot => s != null)
    .sort((a, b) => a.driveTimeMinutes - b.driveTimeMinutes);
}

/**
 * Pick up to one spot per band, optionally favoring iOverlander → Park4Night →
 * Google Places when multiple are tied. Used to give Penny ~3 candidates.
 */
export function pickBestPerBand(banded: BandedSpot[]): BandedSpot[] {
  const order: OvernightSource[] = ['ioverlander', 'park4night', 'google_places'];
  const byBand = new Map<BandedSpot['band'], BandedSpot[]>();
  for (const s of banded) {
    const list = byBand.get(s.band) ?? [];
    list.push(s);
    byBand.set(s.band, list);
  }
  const out: BandedSpot[] = [];
  for (const band of ['short', 'medium', 'long'] as const) {
    const list = byBand.get(band);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => {
      const ai = order.indexOf(a.source);
      const bi = order.indexOf(b.source);
      if (ai !== bi) return ai - bi;
      return a.driveTimeMinutes - b.driveTimeMinutes;
    });
    out.push(list[0]);
  }
  return out;
}
