import { z } from 'zod';
import {
  requireUserId,
  assertRouteOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getRoute, updateRoute, deleteRoute } from '@/server/repos/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  tripId: z.number().int().positive().optional(),
  label: z.string().optional(),
  description: z.string().nullish(),
  distance_km: z.number().nullish(),
  surface: z.string().nullish(),
  status: z.string().optional(),
  gpx_trail_id: z.number().int().positive().nullish(),
  sort_order: z.number().int().optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertRouteOwnedByUser(id, userId);
    const body = patchSchema.parse(await request.json());
    const { tripId: _t, ...data } = body;
    const route = await updateRoute(id, data as any);
    if (!route) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(route);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertRouteOwnedByUser(id, userId);
    if (!(await getRoute(id))) return Response.json({ error: 'Not found' }, { status: 404 });
    await deleteRoute(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
