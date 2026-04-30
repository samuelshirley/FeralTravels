import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VEHICLE_TYPES = ['4x4_suv', 'pickup', 'van', 'motorcycle', 'sedan', 'other'] as const;
const FUEL_TYPES = ['diesel', 'petrol', 'premium', 'lpg'] as const;
const FUEL_TIMING_PREFS = ['start_of_day', 'when_low', 'end_of_day'] as const;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  vehicle_type: z.enum(VEHICLE_TYPES).nullish(),
  notes: z.string().max(2000).nullish(),
  height_cm: z.number().int().positive().nullish(),
  length_m: z.number().positive().nullish(),
  weight_kg: z.number().positive().nullish(),
  fuel_economy_kmpl: z.number().positive().nullish(),
  real_world_kmpl: z.number().positive().nullish(),
  fuel_tank_l: z.number().positive().nullish(),
  fuel_type: z.enum(FUEL_TYPES).nullish(),
  fuel_timing_pref: z.enum(FUEL_TIMING_PREFS).nullish(),
  max_drive_hours_per_day: z.number().positive().nullish(),
  max_drive_hours_per_week: z.number().positive().nullish(),
  max_consecutive_drive_days: z.number().int().positive().nullish(),
  freshwater_capacity_l: z.number().positive().nullish(),
  blackwater_capacity_l: z.number().positive().nullish(),
  water_refill_days: z.number().int().positive().nullish(),
  blackwater_refill_days: z.number().int().positive().nullish(),
  is_default: z.boolean().optional(),
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const vehicles = await listVehiclesForUser(userId);
    return Response.json(vehicles);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await req.json());
    const vehicle = await addVehicle(userId, body);
    return Response.json(vehicle);
  } catch (err) {
    return errorResponse(err);
  }
}
