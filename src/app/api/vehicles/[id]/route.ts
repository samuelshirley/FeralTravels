import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import {
  deleteVehicle,
  getVehicleForUser,
  setDefaultVehicle,
  updateVehicle,
} from '@/server/repos/vehicles';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
  deriveFromTravelStyle,
  vehicleMeetsFuelPlanningMinimum,
  type TravelStyle,
} from '@/lib/vehicleProfile';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  refill_distance_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),
  travel_style: z.enum(['scenic_cruiser', 'road_tripper', 'get_me_there']).nullish(),
  cruise_max_drive_hours: z.number().positive().max(24).nullish(),
  transit_max_drive_hours: z.number().positive().max(24).nullish(),
  max_drive_hours_per_day: z.number().positive().max(24).nullish(),
  max_drive_hours_per_week: z.number().positive().max(168).nullish(),
  max_consecutive_drive_days: z
    .number()
    .int()
    .positive()
    .max(MAX_CONSECUTIVE_DRIVE_DAYS_CAP)
    .nullish(),
  rest_days_after_driving: z.number().int().positive().max(7).nullish(),
  dump_station_interval_days: z.number().int().positive().max(60).nullish(),
  dump_station_tracking_enabled: z.boolean().nullish(),
  is_default: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(ctx.params.id);
    if (!id) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
    const v = await getVehicleForUser(userId, id);
    if (!v) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(v);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(ctx.params.id);
    if (!id) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
    const body = patchSchema.parse(await req.json());

    // PATCH { is_default: true } as the ONLY field is the dedicated
    // "set as default" action; route it through the atomic helper.
    const keys = Object.keys(body);
    if (keys.length === 1 && body.is_default === true) {
      const updated = await setDefaultVehicle(userId, id);
      if (!updated) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(updated);
    }

    const before = await getVehicleForUser(userId, id);
    if (!before) return Response.json({ error: 'Not found' }, { status: 404 });

    // When travel_style is set, derive the hour caps + legacy fields
    const patch = { ...body };
    if (patch.travel_style) {
      const derived = deriveFromTravelStyle(patch.travel_style as TravelStyle);
      patch.cruise_max_drive_hours = derived.cruise_max_drive_hours;
      patch.transit_max_drive_hours = derived.transit_max_drive_hours;
      patch.max_drive_hours_per_day = derived.max_drive_hours_per_day;
    }

    const merged = {
      ...before,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.refill_distance_km !== undefined && { refill_distance_km: patch.refill_distance_km }),
      ...(patch.travel_style !== undefined && { travel_style: patch.travel_style }),
      ...(patch.max_drive_hours_per_day !== undefined && {
        max_drive_hours_per_day: patch.max_drive_hours_per_day,
      }),
      ...(patch.max_drive_hours_per_week !== undefined && {
        max_drive_hours_per_week: patch.max_drive_hours_per_week,
      }),
      ...(patch.max_consecutive_drive_days !== undefined && {
        max_consecutive_drive_days: patch.max_consecutive_drive_days,
      }),
      ...(patch.dump_station_interval_days !== undefined && {
        dump_station_interval_days: patch.dump_station_interval_days,
      }),
      ...(patch.dump_station_tracking_enabled !== undefined && {
        dump_station_tracking_enabled: patch.dump_station_tracking_enabled,
      }),
    } as Record<string, unknown>;

    if (!vehicleMeetsFuelPlanningMinimum(merged)) {
      throw new HttpError(
        400,
        `Refill distance is required: set “refuel every X km” between ${FUEL_STOP_SPACING_KM_MIN} and ${FUEL_STOP_SPACING_KM_MAX} km.`
      );
    }

    const updated = await updateVehicle(userId, id, patch);
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseUUID(ctx.params.id);
    if (!id) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
    const result = await deleteVehicle(userId, id);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
