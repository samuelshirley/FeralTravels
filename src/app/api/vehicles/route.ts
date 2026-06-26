import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
  deriveFromTravelStyle,
  vehicleIsCompleteForRemediation,
  type TravelStyle,
} from '@/lib/vehicleProfile';
import { addVehicle, listVehiclesForUser } from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    travel_style: z.enum(['scenic_cruiser', 'road_tripper', 'get_me_there']),
    // Legacy fields — accepted for backward compat but ignored when travel_style is set
    max_drive_hours_per_day: z.number().positive().max(24).optional(),
    max_drive_hours_per_week: z.number().positive().max(168).optional(),
    cruise_max_drive_hours: z.number().positive().max(24).optional(),
    transit_max_drive_hours: z.number().positive().max(24).optional(),
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

    // Derive hour caps from travel style
    const derived = deriveFromTravelStyle(body.travel_style as TravelStyle);

    const mergedRecord: Record<string, unknown> = {
      name: body.name,
      comfortable_range_km: body.comfortable_range_km,
      travel_style: body.travel_style,
      max_drive_hours_per_day: derived.max_drive_hours_per_day,
      max_drive_hours_per_week: derived.max_drive_hours_per_day * body.max_consecutive_drive_days,
      max_consecutive_drive_days: body.max_consecutive_drive_days,
      dump_station_tracking_enabled: body.dump_station_tracking_enabled,
      dump_station_interval_days: body.dump_station_interval_days ?? null,
    };

    if (!vehicleIsCompleteForRemediation(mergedRecord)) {
      throw new HttpError(400, 'Vehicle profile is incomplete.');
    }

    const vehicle = await addVehicle(userId, {
      name: body.name,
      comfortable_range_km: body.comfortable_range_km,
      // Safe default: no separate ceiling → equals comfortable (never stretch).
      hard_max_range_km: body.hard_max_range_km ?? body.comfortable_range_km,
      travel_style: body.travel_style,
      cruise_max_drive_hours: derived.cruise_max_drive_hours,
      transit_max_drive_hours: derived.transit_max_drive_hours,
      max_drive_hours_per_day: derived.max_drive_hours_per_day,
      max_drive_hours_per_week: derived.max_drive_hours_per_day * body.max_consecutive_drive_days,
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
