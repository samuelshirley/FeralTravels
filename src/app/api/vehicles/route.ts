import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vehicle profile is intentionally narrow — see schema.ts for the rationale.
// Only a name is required; everything else is optional and nullable so users
// can fill the profile in piecemeal (and so Penny can do the same during
// onboarding).
const createSchema = z.object({
  name: z.string().min(1).max(100),
  refill_distance_km: z.number().int().positive().max(5000).nullish(),
  max_drive_hours_per_day: z.number().positive().max(24).nullish(),
  max_drive_hours_per_week: z.number().positive().max(168).nullish(),
  max_consecutive_drive_days: z.number().int().positive().max(60).nullish(),
  water_refill_days: z.number().int().positive().max(60).nullish(),
  blackwater_refill_days: z.number().int().positive().max(60).nullish(),
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
