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

// MVP vehicle profile: name + fuel range.
const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  range_km: z
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
      ...(patch.range_km !== undefined && { range_km: patch.range_km }),
    } as Record<string, unknown>;

    if (!vehicleMeetsFuelPlanningMinimum(merged)) {
      throw new HttpError(
        400,
        `Fuel range is required: set it between ${FUEL_STOP_SPACING_KM_MIN} and ${FUEL_STOP_SPACING_KM_MAX} km.`
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
