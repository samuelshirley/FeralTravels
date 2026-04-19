import { z } from 'zod';
import {
  requireUserId,
  assertRouteOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { addRouteLink, deleteRouteLink, getRoute } from '@/server/repos/routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  tripId: z.number().int().positive().optional(),
  url: z.string().min(1),
  label: z.string().optional(),
  type: z.string().optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const routeId = parseInt(params.id, 10);
    if (Number.isNaN(routeId)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertRouteOwnedByUser(routeId, userId);
    if (!(await getRoute(routeId))) return Response.json({ error: 'Route not found' }, { status: 404 });
    const body = createSchema.parse(await request.json());
    const link = await addRouteLink({
      route_id: routeId,
      url: body.url,
      label: body.label || body.type || 'link',
      type: body.type || 'other',
    });
    return Response.json(link);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const routeId = parseInt(params.id, 10);
    if (Number.isNaN(routeId)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertRouteOwnedByUser(routeId, userId);
    const url = new URL(request.url);
    const linkIdRaw = url.searchParams.get('linkId');
    if (!linkIdRaw) return Response.json({ error: 'linkId query param is required' }, { status: 400 });
    const linkId = parseInt(linkIdRaw, 10);
    if (Number.isNaN(linkId)) return Response.json({ error: 'linkId must be a number' }, { status: 400 });
    const ok = await deleteRouteLink(linkId);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
