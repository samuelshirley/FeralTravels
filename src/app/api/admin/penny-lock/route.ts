import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import {
  pennyLocked,
  setPennyLocked,
  invalidateBreakerFacts,
  breakerSnapshot,
} from '@/server/payments';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Close the app to Penny by hand, and open it again.
 *
 * The circuit breakers below it are automatic and measured; this is the one the
 * owner throws from a phone at two in the morning having decided, for whatever
 * reason, that Penny should stop spending money right now. It is a database row
 * (`app_meta.penny_locked`) rather than an env var for exactly the reason the
 * paywall switch is: the control you reach for in a hurry cannot take a deploy.
 *
 * `requireAdmin()` is cookie-only by design (see guards.ts), so a bearer token
 * cannot reach it and the app can never call this however it is built.
 *
 * EVERY FLIP IS LOGGED to `usage_events` with the admin who pressed it, because
 * `app_meta` has nowhere to record an author and "who closed the app, and when"
 * is the first question asked afterwards.
 */
const schema = z.object({ locked: z.boolean() });

export async function GET() {
  try {
    await requireAdmin();
    // Fresh, never cached: the whole point is seeing your own flip.
    const snapshot = await breakerSnapshot();
    return Response.json(
      { locked: snapshot.facts.manualLock, worst: snapshot.worst, statuses: snapshot.statuses },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const { locked } = schema.parse(await req.json());

    await setPennyLocked(locked);
    /*
     * The lock is one of the facts the breaker cache holds, so flipping it
     * without dropping that cache would leave this instance serving the old
     * answer for up to thirty seconds — which is the whole window the admin is
     * standing there watching. It only drops THIS instance's cache; the others
     * pick the row up when theirs expires, which is the documented bound.
     */
    invalidateBreakerFacts();

    await logUsageEvent({
      userId: admin.id,
      provider: 'admin:penny-lock',
      requests: 0,
      success: true,
      errorMessage: `${admin.email} turned the Penny lock ${locked ? 'ON' : 'OFF'}`,
    }).catch(() => {});

    console.warn(`[admin/penny-lock] ${admin.email} turned the lock ${locked ? 'ON' : 'OFF'}`);

    return Response.json({ locked: await pennyLocked() });
  } catch (err) {
    return errorResponse(err);
  }
}
