import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { dismissAnnouncement } from '@/server/repos/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const dismissSchema = z.object({
  announcementId: z.string().uuid(),
});

/** Dismiss an announcement for the signed-in user (idempotent). */
export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const body = dismissSchema.parse(await request.json());
    await dismissAnnouncement(userId, body.announcementId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
