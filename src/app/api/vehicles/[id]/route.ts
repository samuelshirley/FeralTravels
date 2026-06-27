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
  vehicleMeetsFuelPlanningMinimum,
} from '@/lib/vehicleProfile';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// MVP vehicle profile: name + comfortable range (+ optional hard-max ceiling).
const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  comfortable_range_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),
  hard_max_range_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),
  fuel_type: z.enum(['diesel', 'petrol']).nullish(),
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

    const patch = { ...body };

    const merged = {
      ...before,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.comfortable_range_km !== undefined && { comfortable_range_km: patch.comfortable_range_km }),
      ...(patch.hard_max_range_km !== undefined && { hard_max_range_km: patch.hard_max_range_km }),
    } as Record<string, unknown>;

    if (!vehicleMeetsFuelPlanningMinimum(merged)) {
      throw new HttpError(
        400,
        `Comfortable range is required: set it between ${FUEL_STOP_SPACING_KM_MIN} and ${FUEL_STOP_SPACING_KM_MAX} km.`
      );
    }

    // Hard ceiling must never sit below the comfortable range.
    const mergedComfortable = merged.comfortable_range_km;
    const mergedHardMax = merged.hard_max_range_km;
    if (
      typeof mergedComfortable === 'number' &&
      typeof mergedHardMax === 'number' &&
      mergedHardMax < mergedComfortable
    ) {
      throw new HttpError(
        400,
        'Hard-max range must be the same as or further than the comfortable range.'
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
