import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { paywallEnabled, setPaywallEnabled } from '@/server/payments';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turn paywall enforcement on and off, from /admin.
 *
 * It used to be `PAYWALL_ENABLED=1` in Vercel, which meant the control you
 * reach for when the paywall is blocking people who should not be blocked
 * required a redeploy to use. A switch whose entire purpose is being flipped
 * back in a hurry cannot take a build.
 *
 * `requireAdmin()` is cookie-only by design (see guards.ts), so a bearer token
 * cannot reach it and the mobile app can never call this however it is built.
 * Same posture as `/api/admin/test-users` and `/api/admin/promo`.
 *
 * EVERY FLIP IS LOGGED to `usage_events` with the admin who pressed it.
 * `app_meta` is a key/value table with nowhere to record an author, and "who
 * turned the paywall on, and when" is the first question asked the first time
 * somebody is blocked unexpectedly. `success: true` because this is a
 * deliberate act and not a failure — it is in the ledger to be findable, not to
 * be alarming.
 */
const schema = z.object({ enabled: z.boolean() });

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ enabled: await paywallEnabled() }, {
      // Never cached: the whole point is seeing your own flip immediately.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const { enabled } = schema.parse(await req.json());

    await setPaywallEnabled(enabled);

    await logUsageEvent({
      userId: admin.id,
      provider: 'admin:paywall-switch',
      requests: 0,
      success: true,
      errorMessage: `${admin.email} turned the paywall ${enabled ? 'ON' : 'OFF'}`,
    }).catch(() => {});

    console.warn(`[admin/paywall] ${admin.email} turned enforcement ${enabled ? 'ON' : 'OFF'}`);

    return Response.json({ enabled: await paywallEnabled() });
  } catch (err) {
    return errorResponse(err);
  }
}
