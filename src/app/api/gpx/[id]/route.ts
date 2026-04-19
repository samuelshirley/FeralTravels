import path from 'path';
import fs from 'fs/promises';
import {
  requireUserId,
  assertGpxOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { deleteGpxTrail } from '@/server/repos/gpx';
import { GPX_DIR } from '@/lib/gpx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) return Response.json({ error: 'id must be a number' }, { status: 400 });
    await assertGpxOwnedByUser(id, userId);
    const trail = await deleteGpxTrail(id);
    if (!trail) return Response.json({ error: 'Not found' }, { status: 404 });
    try {
      await fs.unlink(path.join(GPX_DIR, trail.filename));
    } catch {
      /* ignore */
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
