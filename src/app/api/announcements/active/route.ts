import { requireUserId, errorResponse } from '@/server/auth/guards';
import { getActiveAnnouncementForUser } from '@/server/repos/announcements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Return the newest undismissed active announcement for the signed-in user. */
export async function GET() {
  try {
    const userId = await requireUserId();
    const announcement = await getActiveAnnouncementForUser(userId);
    return Response.json({ announcement });
  } catch (err) {
    return errorResponse(err);
  }
}
