import { auth } from '@/server/auth';
import { isAdmin, errorResponse, HttpError } from '@/server/auth/guards';
import { runNightlyReplan } from '@/lib/replan/runReplan';

/**
 * Admin-only manual trigger for the nightly replan.
 *
 *   POST /api/admin/run-replan
 *
 * Runs the same logic as the scheduled cron (recompute drive times + send
 * morning / rest-day / off-route / stale emails) but with force=true, so it
 * processes active trips immediately regardless of the time of day rather
 * than waiting for each traveler's ~2am window.
 *
 * Returns 404 (not 403) for non-admins so the route's existence isn't leaked,
 * mirroring the other admin endpoints.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min — replanning many trips can be slow

export async function POST(): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.email || !(await isAdmin(session.user.email))) {
      throw new HttpError(404, 'Not found');
    }

    const result = await runNightlyReplan({ force: true });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
