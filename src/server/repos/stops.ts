import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { stops } from '@/server/db/schema';
import type {
  Stop,
  StopStatus,
  StopSource,
  StopType,
  FuelType,
} from '@/types/trip';
import { rowMappers } from './trips';

export async function getStopsForLeg(legId: string): Promise<Stop[]> {
  const rows = await db
    .select()
    .from(stops)
    .where(eq(stops.legId, legId))
    .orderBy(asc(stops.sortOrder), asc(stops.id));
  return rows.map(rowMappers.stopRow);
}

export async function getStop(id: string): Promise<Stop | null> {
  const rows = await db.select().from(stops).where(eq(stops.id, id)).limit(1);
  return rows[0] ? rowMappers.stopRow(rows[0]) : null;
}

export interface CreateStopInput {
  leg_id: string;
  stop_type: StopType;
  name: string;
  status?: StopStatus;
  lat?: number | null;
  lng?: number | null;
  distance_from_start_km?: number | null;
  notes?: string | null;
  fuel_type?: FuelType | null;
  fuel_amount_l?: number | null;
  source?: StopSource | null;
  source_url?: string | null;
  sort_order?: number | null;
  place_id?: string | null;
  google_maps_uri?: string | null;
}

export async function addStop(input: CreateStopInput): Promise<Stop> {
  const next = await db
    .select({ next: sql<number>`COALESCE(MAX(${stops.sortOrder}), -1) + 1` })
    .from(stops)
    .where(eq(stops.legId, input.leg_id));
  const sortOrder = input.sort_order ?? next[0]?.next ?? 0;

  const [row] = await db
    .insert(stops)
    .values({
      legId: input.leg_id,
      sortOrder,
      stopType: input.stop_type,
      status: input.status ?? 'option',
      name: input.name,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      distanceFromStartKm: input.distance_from_start_km ?? null,
      notes: input.notes ?? null,
      fuelType: input.fuel_type ?? null,
      fuelAmountL: input.fuel_amount_l ?? null,
      source: input.source ?? null,
      sourceUrl: input.source_url ?? null,
      placeId: input.place_id ?? null,
      googleMapsUri: input.google_maps_uri ?? null,
    })
    .returning();
  return rowMappers.stopRow(row);
}

export type UpdateStopInput = Partial<{
  stop_type: StopType;
  status: StopStatus;
  name: string;
  lat: number | null;
  lng: number | null;
  distance_from_start_km: number | null;
  notes: string | null;
  fuel_type: FuelType | null;
  fuel_amount_l: number | null;
  source: StopSource | null;
  source_url: string | null;
  sort_order: number;
  place_id: string | null;
  google_maps_uri: string | null;
}>;

export async function updateStop(id: string, data: UpdateStopInput): Promise<Stop | null> {
  const update: Record<string, unknown> = {};
  if (data.stop_type !== undefined) update.stopType = data.stop_type;
  if (data.status !== undefined) update.status = data.status;
  if (data.name !== undefined) update.name = data.name;
  if (data.lat !== undefined) update.lat = data.lat;
  if (data.lng !== undefined) update.lng = data.lng;
  if (data.distance_from_start_km !== undefined)
    update.distanceFromStartKm = data.distance_from_start_km;
  if (data.notes !== undefined) update.notes = data.notes;
  if (data.fuel_type !== undefined) update.fuelType = data.fuel_type;
  if (data.fuel_amount_l !== undefined) update.fuelAmountL = data.fuel_amount_l;
  if (data.source !== undefined) update.source = data.source;
  if (data.source_url !== undefined) update.sourceUrl = data.source_url;
  if (data.sort_order !== undefined) update.sortOrder = data.sort_order;
  if (data.place_id !== undefined) update.placeId = data.place_id;
  if (data.google_maps_uri !== undefined) update.googleMapsUri = data.google_maps_uri;
  if (Object.keys(update).length === 0) return getStop(id);
  update.updatedAt = new Date();
  await db.update(stops).set(update).where(eq(stops.id, id));
  return getStop(id);
}

export async function deleteStop(id: string): Promise<boolean> {
  const result = await db.delete(stops).where(eq(stops.id, id)).returning({ id: stops.id });
  return result.length > 0;
}

/**
 * Flip a stop to status='selected' so it becomes a waypoint in the leg's Google
 * Maps URL. Unlike routes, multiple stops can be selected per leg (each becomes
 * its own waypoint in travel order).
 */
export async function selectStop(id: string): Promise<{ stop: Stop; legId: string } | null> {
  const existing = await db
    .select({ legId: stops.legId })
    .from(stops)
    .where(eq(stops.id, id))
    .limit(1);
  if (existing.length === 0) return null;
  const legId = existing[0].legId;
  await db
    .update(stops)
    .set({ status: 'selected', updatedAt: new Date() })
    .where(eq(stops.id, id));
  const stop = await getStop(id);
  if (!stop) return null;
  return { stop, legId };
}

export async function dismissStop(id: string): Promise<Stop | null> {
  await db
    .update(stops)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(eq(stops.id, id));
  return getStop(id);
}
