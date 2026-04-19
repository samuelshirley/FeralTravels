import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { vehicles } from '@/server/db/schema';

export type VehicleRow = typeof vehicles.$inferSelect;

function vehicleApi(r: VehicleRow) {
  return {
    id: r.id,
    user_id: r.userId,
    name: r.name,
    is_default: r.isDefault,
    height_cm: r.heightCm,
    fuel_economy_kmpl: r.fuelEconomyKmpl,
    fuel_tank_l: r.fuelTankL,
    max_drive_hours_per_day: r.maxDriveHoursPerDay,
    max_drive_hours_per_week: r.maxDriveHoursPerWeek,
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

export async function getDefaultVehicleId(userId: string): Promise<number | null> {
  const r = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.userId, userId), eq(vehicles.isDefault, true)))
    .limit(1);
  return r[0]?.id ?? null;
}
