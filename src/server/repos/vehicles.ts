import 'server-only';
import { and, asc, eq, ne, count } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { vehicles } from '@/server/db/schema';

export type VehicleRow = typeof vehicles.$inferSelect;

export type VehicleType =
  | '4x4_suv'
  | 'pickup'
  | 'van'
  | 'motorcycle'
  | 'sedan'
  | 'other';

export interface VehicleInput {
  name: string;
  vehicle_type?: VehicleType | null;
  notes?: string | null;
  height_cm?: number | null;
  length_m?: number | null;
  weight_kg?: number | null;
  fuel_economy_kmpl?: number | null;
  fuel_tank_l?: number | null;
  max_drive_hours_per_day?: number | null;
  max_drive_hours_per_week?: number | null;
  max_consecutive_drive_days?: number | null;
  freshwater_capacity_l?: number | null;
  blackwater_capacity_l?: number | null;
  water_refill_days?: number | null;
  blackwater_refill_days?: number | null;
  is_default?: boolean;
}

function vehicleApi(r: VehicleRow) {
  return {
    id: r.id,
    user_id: r.userId,
    name: r.name,
    is_default: r.isDefault,
    vehicle_type: (r.vehicleType as VehicleType | null) ?? null,
    notes: r.notes,
    height_cm: r.heightCm,
    length_m: r.lengthM,
    weight_kg: r.weightKg,
    fuel_economy_kmpl: r.fuelEconomyKmpl,
    fuel_tank_l: r.fuelTankL,
    max_drive_hours_per_day: r.maxDriveHoursPerDay,
    max_drive_hours_per_week: r.maxDriveHoursPerWeek,
    max_consecutive_drive_days: r.maxConsecutiveDriveDays,
    freshwater_capacity_l: r.freshwaterCapacityL,
    blackwater_capacity_l: r.blackwaterCapacityL,
    water_refill_days: r.waterRefillDays,
    blackwater_refill_days: r.blackwaterRefillDays,
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
  if (input.vehicle_type !== undefined) map.vehicleType = input.vehicle_type;
  if (input.notes !== undefined) map.notes = input.notes;
  if (input.height_cm !== undefined) map.heightCm = input.height_cm;
  if (input.length_m !== undefined) map.lengthM = input.length_m;
  if (input.weight_kg !== undefined) map.weightKg = input.weight_kg;
  if (input.fuel_economy_kmpl !== undefined) map.fuelEconomyKmpl = input.fuel_economy_kmpl;
  if (input.fuel_tank_l !== undefined) map.fuelTankL = input.fuel_tank_l;
  if (input.max_drive_hours_per_day !== undefined)
    map.maxDriveHoursPerDay = input.max_drive_hours_per_day;
  if (input.max_drive_hours_per_week !== undefined)
    map.maxDriveHoursPerWeek = input.max_drive_hours_per_week;
  if (input.max_consecutive_drive_days !== undefined)
    map.maxConsecutiveDriveDays = input.max_consecutive_drive_days;
  if (input.freshwater_capacity_l !== undefined)
    map.freshwaterCapacityL = input.freshwater_capacity_l;
  if (input.blackwater_capacity_l !== undefined)
    map.blackwaterCapacityL = input.blackwater_capacity_l;
  if (input.water_refill_days !== undefined) map.waterRefillDays = input.water_refill_days;
  if (input.blackwater_refill_days !== undefined)
    map.blackwaterRefillDays = input.blackwater_refill_days;
  return map;
}

export async function addVehicle(userId: string, input: VehicleInput): Promise<VehicleApi> {
  const existing = await db
    .select({ c: count() })
    .from(vehicles)
    .where(eq(vehicles.userId, userId));
  const isFirst = (existing[0]?.c ?? 0) === 0;
  const shouldBeDefault = input.is_default || isFirst;

  return await db.transaction(async (tx) => {
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
}

export async function updateVehicle(
  userId: string,
  vehicleId: number,
  patch: Partial<VehicleInput>
): Promise<VehicleApi | null> {
  const owned = await getVehicleForUser(userId, vehicleId);
  if (!owned) return null;

  return await db.transaction(async (tx) => {
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
}

export async function deleteVehicle(userId: string, vehicleId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const owned = await getVehicleForUser(userId, vehicleId);
  if (!owned) return { ok: false, error: 'Vehicle not found' };

  // Block deletion if it's the only vehicle — every user keeps at least one.
  const allRows = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.userId, userId));
  if (allRows.length <= 1) {
    return { ok: false, error: 'You need at least one vehicle. Add another first.' };
  }
  if (owned.is_default) {
    return {
      ok: false,
      error: 'This is your default vehicle. Set another as default first.',
    };
  }
  await db.delete(vehicles).where(eq(vehicles.id, vehicleId));
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
