import { z } from 'zod';
import { HttpError, requireUserId, errorResponse } from '@/server/auth/guards';
import {
  deleteVehicle,
  getVehicleForUser,
  setDefaultVehicle,
  updateVehicle,
} from '@/server/repos/vehicles';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  refill_distance_km: z.number().int().positive().max(5000).nullish(),
  max_drive_hours_per_day: z.number().positive().max(24).nullish(),
  max_drive_hours_per_week: z.number().positive().max(168).nullish(),
  max_consecutive_drive_days: z.number().int().positive().max(14).nullish(),
  water_refill_days: z.number().int().positive().max(60).nullish(),
  blackwater_refill_days: z.number().int().positive().max(60).nullish(),
  water_tracking_enabled: z.boolean().nullish(),
  is_default: z.boolean().optional(),
});

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseId(ctx.params.id);
    if (id == null) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
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
    const id = parseId(ctx.params.id);
    if (id == null) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
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

    const merged = {
      ...before,
      ...(body.name !== undefined && { name: body.name }),
      ...(body.refill_distance_km !== undefined && { refill_distance_km: body.refill_distance_km }),
      ...(body.max_drive_hours_per_day !== undefined && {
        max_drive_hours_per_day: body.max_drive_hours_per_day,
      }),
      ...(body.max_drive_hours_per_week !== undefined && {
        max_drive_hours_per_week: body.max_drive_hours_per_week,
      }),
      ...(body.max_consecutive_drive_days !== undefined && {
        max_consecutive_drive_days: body.max_consecutive_drive_days,
      }),
      ...(body.water_refill_days !== undefined && { water_refill_days: body.water_refill_days }),
      ...(body.blackwater_refill_days !== undefined && {
        blackwater_refill_days: body.blackwater_refill_days,
      }),
      ...(body.water_tracking_enabled !== undefined && {
        water_tracking_enabled: body.water_tracking_enabled,
      }),
    } as Record<string, unknown>;

    if (!vehicleMeetsFuelPlanningMinimum(merged)) {
      throw new HttpError(
        400,
        'Refill distance is required: set “refuel every X km” to a value between 1 and 5000.'
      );
    }

    const updated = await updateVehicle(userId, id, body);
    if (!updated) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseId(ctx.params.id);
    if (id == null) return Response.json({ error: 'Invalid vehicle id' }, { status: 400 });
    const result = await deleteVehicle(userId, id);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
