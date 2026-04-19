import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { pois } from '@/server/db/schema';
import type { POI } from '@/types/trip';
import { rowMappers } from './trips';

export async function getPoisForTrip(tripId: number): Promise<POI[]> {
  const rows = await db
    .select()
    .from(pois)
    .where(and(eq(pois.tripId, tripId), eq(pois.status, 'active')));
  return rows.map(rowMappers.poiRow);
}

export async function getPoisForLeg(legId: number): Promise<POI[]> {
  const rows = await db
    .select()
    .from(pois)
    .where(and(eq(pois.legId, legId), eq(pois.status, 'active')));
  return rows.map(rowMappers.poiRow);
}
