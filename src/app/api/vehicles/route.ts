import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  vehicleMeetsFuelPlanningMinimum,
} from '@/lib/vehicleProfile';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// MVP vehicle profile: name + fuel range.
// Travel style / driving cadence / dump-station tracking are no longer
// collected — those columns are left dormant.
const createSchema = z.object({
  name: z.string().min(1).max(100),
  range_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX),
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

    if (!vehicleMeetsFuelPlanningMinimum({ range_km: body.range_km })) {
      throw new HttpError(400, 'Vehicle profile is incomplete.');
    }

    const vehicle = await addVehicle(userId, {
      name: body.name,
      range_km: body.range_km,
      is_default: body.is_default,
    });
    return Response.json(vehicle);
  } catch (err) {
    return errorResponse(err);
  }
}
