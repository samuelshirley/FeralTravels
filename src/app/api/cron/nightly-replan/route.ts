import 'server-only';
import { NextRequest } from 'next/server';
import { runNightlyReplan } from '@/lib/replan/runReplan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min for Vercel Pro

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Scheduled nightly replan.
 *
 * NOTE: there is no longer a `crons` entry in vercel.json — the Hobby plan
 * caps cron frequency at once per day, but the per-trip 2am-local gate in
 * runNightlyReplan needs sub-daily firing to cover travelers across
 * timezones. Until that's reconciled (e.g. a Pro plan, or an external
 * scheduler hitting this endpoint with CRON_SECRET), replans are triggered
 * manually from the admin dashboard (POST /api/admin/run-replan).
 *
 * This endpoint stays live so an external scheduler can still drive it:
 * POST with `Authorization: Bearer <CRON_SECRET>`. It runs with force=false
 * so each trip is only processed near the traveler's own 2am.
 */
export async function POST(req: NextRequest) {
  // Verify cron secret (only enforced when CRON_SECRET is configured)
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runNightlyReplan({ force: false });
    return Response.json(result);
  } catch (err) {
    console.error('[nightly-replan] Fatal error:', err);
    return Response.json(
      { error: 'Internal server error', detail: String(err) },
      { status: 500 },
    );
  }
}
