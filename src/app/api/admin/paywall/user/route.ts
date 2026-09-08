import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { setPaywallEnforcedForUser } from '@/server/payments';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Force paywall enforcement on ONE account, from /admin/users/[id].
 *
 * The sibling of `/api/admin/paywall`, and the difference is the blast radius.
 * That one decides whether the paywall applies to the whole deployment; this
 * one applies it to a single row while that switch stays off — which is the
 * only way to test the wall on a deployment whose front page is currently a
 * demo. Turning the global switch on to check a paywall renders would wall
 * every account past its trial, and there is nothing to buy yet.
 *
 * `requireAdmin()` is cookie-only by design (see guards.ts), so a bearer token
 * cannot reach it and the mobile app can never call this however it is built.
 * Same posture as `/api/admin/paywall`, `/api/admin/test-users` and
 * `/api/admin/promo`.
 *
 * EVERY FLIP IS LOGGED to `usage_events` with the admin who pressed it and the
 * account it was pressed on. `users` has nowhere to record an author, and "who
 * paywalled this account" is the first question asked the first time somebody
 * is blocked unexpectedly. `success: true` because this is a deliberate act and
 * not a failure — it is in the ledger to be findable, not to be alarming.
 */
const schema = z.object({
  userId: z.string().min(1),
  enforced: z.boolean(),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const { userId, enforced } = schema.parse(await req.json());

    await setPaywallEnforcedForUser(userId, enforced);

    await logUsageEvent({
      userId: admin.id,
      provider: 'admin:paywall-user-override',
      requests: 0,
      success: true,
      errorMessage: `${admin.email} turned the per-account paywall override ${
        enforced ? 'ON' : 'OFF'
      } for ${userId}`,
    }).catch(() => {});

    console.warn(
      `[admin/paywall/user] ${admin.email} turned the override ${
        enforced ? 'ON' : 'OFF'
      } for ${userId}`
    );

    return Response.json({ userId, enforced });
  } catch (err) {
    return errorResponse(err);
  }
}
