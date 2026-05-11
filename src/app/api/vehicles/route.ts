import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import { vehicleIsCompleteForRemediation } from '@/lib/vehicleProfile';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    refill_distance_km: z.number().int().positive().max(5000),
    max_drive_hours_per_day: z.number().positive().max(24),
    max_drive_hours_per_week: z.number().positive().max(168),
    max_consecutive_drive_days: z.number().int().positive().max(14),
    water_tracking_enabled: z.boolean(),
    water_refill_days: z.number().int().positive().max(60).optional(),
    blackwater_refill_days: z.number().int().positive().max(60).optional(),
    is_default: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.water_tracking_enabled) {
      if (data.water_refill_days == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'When tracking water, set water_refill_days (days between freshwater refills).',
        });
      }
      if (data.blackwater_refill_days == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'When tracking water, set blackwater_refill_days (days between dumps).',
        });
      }
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

    const mergedRecord: Record<string, unknown> = {
      name: body.name,
      refill_distance_km: body.refill_distance_km,
      max_drive_hours_per_day: body.max_drive_hours_per_day,
      max_drive_hours_per_week: body.max_drive_hours_per_week,
      max_consecutive_drive_days: body.max_consecutive_drive_days,
      water_tracking_enabled: body.water_tracking_enabled,
      water_refill_days: body.water_refill_days ?? null,
      blackwater_refill_days: body.blackwater_refill_days ?? null,
    };

    if (!vehicleIsCompleteForRemediation(mergedRecord)) {
      throw new HttpError(400, 'Vehicle profile is incomplete.');
    }

    const vehicle = await addVehicle(userId, {
      name: body.name,
      refill_distance_km: body.refill_distance_km,
      max_drive_hours_per_day: body.max_drive_hours_per_day,
      max_drive_hours_per_week: body.max_drive_hours_per_week,
      max_consecutive_drive_days: body.max_consecutive_drive_days,
      water_tracking_enabled: body.water_tracking_enabled,
      water_refill_days: body.water_refill_days ?? null,
      blackwater_refill_days: body.blackwater_refill_days ?? null,
      is_default: body.is_default,
    });
    return Response.json(vehicle);
  } catch (err) {
    return errorResponse(err);
  }
}
