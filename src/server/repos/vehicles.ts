import 'server-only';
import { and, asc, eq, ne, count } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { vehicles } from '@/server/db/schema';

export type VehicleRow = typeof vehicles.$inferSelect;

export interface VehicleInput {
  name: string;
  refill_distance_km?: number | null;
  max_drive_hours_per_day?: number | null;
  max_drive_hours_per_week?: number | null;
  max_consecutive_drive_days?: number | null;
  water_refill_days?: number | null;
  blackwater_refill_days?: number | null;
  water_tracking_enabled?: boolean | null;
  is_default?: boolean;
}

function vehicleApi(r: VehicleRow) {
  return {
    id: r.id,
    user_id: r.userId,
    name: r.name,
    is_default: r.isDefault,
    refill_distance_km: r.refillDistanceKm,
    max_drive_hours_per_day: r.maxDriveHoursPerDay,
    max_drive_hours_per_week: r.maxDriveHoursPerWeek,
    max_consecutive_drive_days: r.maxConsecutiveDriveDays,
    water_refill_days: r.waterRefillDays,
    blackwater_refill_days: r.blackwaterRefillDays,
    water_tracking_enabled: r.waterTrackingEnabled,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export type VehicleApi = ReturnType<typeof vehicleApi>;

export async function listVehiclesForUser(userId: string): Promise<VehicleApi[]> {
  const rows = await db
    .select()
    .from(vehicles)
    .where(eq(vehicles.userId, userId))
    .orderBy(asc(vehicles.id));
  return rows.map(vehicleApi);
}

export async function getVehicleForUser(
  userId: string,
  vehicleId: number
): Promise<VehicleApi | null> {
  const rows = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.userId, userId), eq(vehicles.id, vehicleId)))
    .limit(1);
  return rows[0] ? vehicleApi(rows[0]) : null;
}

export async function getDefaultVehicleId(userId: string): Promise<number | null> {
  const r = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.userId, userId), eq(vehicles.isDefault, true)))
    .limit(1);
  return r[0]?.id ?? null;
}

export async function getDefaultVehicleForUser(userId: string): Promise<VehicleApi | null> {
  const id = await getDefaultVehicleId(userId);
  if (id == null) {
    // Fall back to the first vehicle so Penny still has constraints.
    const rows = await db
      .select()
      .from(vehicles)
      .where(eq(vehicles.userId, userId))
      .orderBy(asc(vehicles.id))
      .limit(1);
    return rows[0] ? vehicleApi(rows[0]) : null;
  }
  return getVehicleForUser(userId, id);
}

function inputToColumns(input: Partial<VehicleInput>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (input.name !== undefined) map.name = input.name;
  if (input.refill_distance_km !== undefined) map.refillDistanceKm = input.refill_distance_km;
  if (input.max_drive_hours_per_day !== undefined)
    map.maxDriveHoursPerDay = input.max_drive_hours_per_day;
  if (input.max_drive_hours_per_week !== undefined)
    map.maxDriveHoursPerWeek = input.max_drive_hours_per_week;
  if (input.max_consecutive_drive_days !== undefined)
    map.maxConsecutiveDriveDays = input.max_consecutive_drive_days;
  if (input.water_refill_days !== undefined) map.waterRefillDays = input.water_refill_days;
  if (input.blackwater_refill_days !== undefined)
    map.blackwaterRefillDays = input.blackwater_refill_days;
  if (input.water_tracking_enabled !== undefined)
    map.waterTrackingEnabled = input.water_tracking_enabled;
  return map;
}

export async function addVehicle(userId: string, input: VehicleInput): Promise<VehicleApi> {
  const existing = await db
    .select({ c: count() })
    .from(vehicles)
    .where(eq(vehicles.userId, userId));
  const isFirst = (existing[0]?.c ?? 0) === 0;
  const shouldBeDefault = input.is_default || isFirst;

  const result = await db.transaction(async (tx) => {
    if (shouldBeDefault) {
      await tx
        .update(vehicles)
        .set({ isDefault: false })
        .where(eq(vehicles.userId, userId));
    }
    const [row] = await tx
      .insert(vehicles)
      .values({
        userId,
        name: input.name,
        isDefault: shouldBeDefault,
        ...inputToColumns(input),
      })
      .returning();
    return vehicleApi(row);
  });
  const { recalculateUserRemediationFlag } = await import('@/server/repos/remediationFlags');
  await recalculateUserRemediationFlag(userId);
  return result;
}

export async function updateVehicle(
  userId: string,
  vehicleId: number,
  patch: Partial<VehicleInput>
): Promise<VehicleApi | null> {
  const owned = await getVehicleForUser(userId, vehicleId);
  if (!owned) return null;

  const updated = await db.transaction(async (tx) => {
    if (patch.is_default === true) {
      await tx
        .update(vehicles)
        .set({ isDefault: false })
        .where(and(eq(vehicles.userId, userId), ne(vehicles.id, vehicleId)));
    }
    const cols = inputToColumns(patch);
    if (patch.is_default !== undefined) cols.isDefault = patch.is_default;
    cols.updatedAt = new Date();
    if (Object.keys(cols).length > 0) {
      await tx.update(vehicles).set(cols).where(eq(vehicles.id, vehicleId));
    }
    const [row] = await tx
      .select()
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .limit(1);
    return row ? vehicleApi(row) : null;
  });
  const { recalculateUserRemediationFlag } = await import('@/server/repos/remediationFlags');
  await recalculateUserRemediationFlag(userId);
  return updated;
}

export async function deleteVehicle(
  userId: string,
  vehicleId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const owned = await getVehicleForUser(userId, vehicleId);
  if (!owned) return { ok: false, error: 'Vehicle not found' };

  const allRows = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.userId, userId));
  if (owned.is_default && allRows.length > 1) {
    return {
      ok: false,
      error: 'This is your default vehicle. Set another as default first.',
    };
  }
  await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
  const { recalculateUserRemediationFlag } = await import('@/server/repos/remediationFlags');
  await recalculateUserRemediationFlag(userId);
  return { ok: true };
}

export async function setDefaultVehicle(
  userId: string,
  vehicleId: number
): Promise<VehicleApi | null> {
  const owned = await getVehicleForUser(userId, vehicleId);
  if (!owned) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(vehicles)
      .set({ isDefault: false })
      .where(eq(vehicles.userId, userId));
    await tx
      .update(vehicles)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(vehicles.id, vehicleId));
  });
  return getVehicleForUser(userId, vehicleId);
}
