import { requireUserId, errorResponse } from '@/server/auth/guards';
import { listFeatureRequestsForUser } from '@/server/repos/featureRequests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The feature-request list for the signed-in user (iOS: Account menu →
 * Feature requests). Already in display order — see `compareFeatureRequests`.
 * No entitlement gate: reading and voting spend nothing, and a lapsed trial's
 * vote is still a vote.
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    return Response.json({ requests: await listFeatureRequestsForUser(userId) });
  } catch (err) {
    return errorResponse(err);
  }
}
