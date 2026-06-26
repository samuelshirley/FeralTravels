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

// MVP vehicle profile: name + comfortable range (+ optional hard-max ceiling).
// Travel style / driving cadence / dump-station tracking are no longer
// collected — those columns are left dormant.
const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    comfortable_range_km: z
      .number()
      .int()
      .min(FUEL_STOP_SPACING_KM_MIN)
      .max(FUEL_STOP_SPACING_KM_MAX),
    hard_max_range_km: z
      .number()
      .int()
      .min(FUEL_STOP_SPACING_KM_MIN)
      .max(FUEL_STOP_SPACING_KM_MAX)
      .nullish(),
    is_default: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.hard_max_range_km != null &&
      data.hard_max_range_km < data.comfortable_range_km
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hard_max_range_km'],
        message: 'hard_max_range_km must be ≥ comfortable_range_km.',
      });
    }
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

    if (!vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: body.comfortable_range_km })) {
      throw new HttpError(400, 'Vehicle profile is incomplete.');
    }

    const vehicle = await addVehicle(userId, {
      name: body.name,
      comfortable_range_km: body.comfortable_range_km,
      // Safe default: no separate ceiling → equals comfortable (never stretch).
      hard_max_range_km: body.hard_max_range_km ?? body.comfortable_range_km,
      is_default: body.is_default,
    });
    return Response.json(vehicle);
  } catch (err) {
    return errorResponse(err);
  }
}
