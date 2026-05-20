import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import {
  listAnnouncements,
  createAnnouncement,
  deactivateAnnouncement,
  activateAnnouncement,
} from '@/server/repos/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
    return Response.json(await listAnnouncements());
  } catch (err) {
    return errorResponse(err);
  }
}

const createSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  buttonText: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const data = createSchema.parse(await request.json());
    const row = await createAnnouncement(data);
    return Response.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean(),
});

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const data = patchSchema.parse(await request.json());
    if (data.active) {
      await activateAnnouncement(data.id);
    } else {
      await deactivateAnnouncement(data.id);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
