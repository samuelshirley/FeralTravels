import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import {
  deleteVehicle,
  getVehicleForUser,
  setDefaultVehicle,
  updateVehicle,
} from '@/server/repos/vehicles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VEHICLE_TYPES = ['4x4_suv', 'pickup', 'van', 'motorcycle', 'sedan', 'other'] as const;

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  vehicle_type: z.enum(VEHICLE_TYPES).nullish(),
  notes: z.string().max(2000).nullish(),
  height_cm: z.number().int().positive().nullish(),
  length_m: z.number().positive().nullish(),
  weight_kg: z.number().positive().nullish(),
  fuel_economy_kmpl: z.number().positive().nullish(),
  fuel_tank_l: z.number().positive().nullish(),
  max_drive_hours_per_day: z.number().positive().nullish(),
  max_drive_hours_per_week: z.number().positive().nullish(),
  max_consecutive_drive_days: z.number().int().positive().nullish(),
  freshwater_capacity_l: z.number().positive().nullish(),
  blackwater_capacity_l: z.number().positive().nullish(),
  water_refill_days: z.number().int().positive().nullish(),
  blackwater_refill_days: z.number().int().positive().nullish(),
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
