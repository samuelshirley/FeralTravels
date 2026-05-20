import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
  vehicleIsCompleteForRemediation,
} from '@/lib/vehicleProfile';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    refill_distance_km: z
      .number()
      .int()
      .min(FUEL_STOP_SPACING_KM_MIN)
      .max(FUEL_STOP_SPACING_KM_MAX),
    max_drive_hours_per_day: z.number().positive().max(24),
    max_drive_hours_per_week: z.number().positive().max(168),
    max_consecutive_drive_days: z
      .number()
      .int()
      .positive()
      .max(MAX_CONSECUTIVE_DRIVE_DAYS_CAP),
    dump_station_tracking_enabled: z.boolean(),
    dump_station_interval_days: z.number().int().positive().max(60).nullish(),
    is_default: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.dump_station_tracking_enabled) {
      if (data.dump_station_interval_days == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'When tracking dump stations, set dump_station_interval_days (days between visits).',
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
      dump_station_tracking_enabled: body.dump_station_tracking_enabled,
      dump_station_interval_days: body.dump_station_interval_days ?? null,
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
      dump_station_tracking_enabled: body.dump_station_tracking_enabled,
      dump_station_interval_days: body.dump_station_interval_days ?? null,
      is_default: body.is_default,
    });
    return Response.json(vehicle);
  } catch (err) {
    return errorResponse(err);
  }
}
