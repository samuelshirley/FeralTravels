import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { gpxTrails, legs } from '@/server/db/schema';
import type { GPXTrail } from '@/types/trip';

function gpxRow(r: typeof gpxTrails.$inferSelect): GPXTrail {
  return {
    id: r.id,
    leg_id: r.legId,
    name: r.name,
    filename: r.filename,
    source: r.source,
    source_url: r.sourceUrl,
    distance_km: r.distanceKm,
    surface: r.surface,
    verified: r.verified,
    notes: r.notes,
  };
}

export async function getGpxTrailsForLeg(legId: string): Promise<GPXTrail[]> {
  const rows = await db.select().from(gpxTrails).where(eq(gpxTrails.legId, legId));
  return rows.map(gpxRow);
}

export async function addGpxTrail(input: {
  trip_id: string;
  leg_id: string;
  name: string;
  filename: string;
  source?: string | null;
  source_url?: string | null;
  distance_km?: number | null;
  surface?: string | null;
  notes?: string | null;
}): Promise<GPXTrail> {
  const [row] = await db
    .insert(gpxTrails)
    .values({
      tripId: input.trip_id,
      legId: input.leg_id,
      name: input.name,
      filename: input.filename,
      source: input.source ?? null,
      sourceUrl: input.source_url ?? null,
      distanceKm: input.distance_km ?? null,
      surface: input.surface ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return gpxRow(row);
}

export async function deleteGpxTrail(id: string): Promise<GPXTrail | null> {
  const rows = await db.select().from(gpxTrails).where(eq(gpxTrails.id, id)).limit(1);
  if (rows.length === 0) return null;
  await db.delete(gpxTrails).where(eq(gpxTrails.id, id));
  return gpxRow(rows[0]);
}
