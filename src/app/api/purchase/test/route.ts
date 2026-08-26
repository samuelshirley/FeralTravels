import { z } from 'zod';
import { requireUser, errorResponse, ForbiddenError } from '@/server/auth/guards';
import { db } from '@/server/db/client';
import { subscriptionEvents } from '@/server/db/schema';
import { isProductId, productById, upsertSubscription } from '@/server/payments';
import { isTestPurchaseAllowed } from '@/server/payments/testPurchase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ productId: z.string().min(1).max(120) });

/**
 * Grant a subscription without Apple, for allowlisted addresses only.
 *
 * This exists because the paywall has to be walkable end-to-end on a real
 * device before the Paid Applications Agreement is active — until it is,
 * StoreKit returns an EMPTY product list in sandbox and TestFlight, with no
 * useful error, so there is literally no purchase sheet to test against.
 *
 * Three things keep it from being a hole:
 *   1. `SUBSCRIPTION_TEST_EMAILS` defaults to empty. Unset grants nothing.
 *   2. The check happens HERE, server-side, on the session's own email. The
 *      client is told whether to show the button, but is never believed.
 *   3. Every grant is written to `subscription_events` with `source: 'fake'`,
 *      so an unpaid subscription is distinguishable from a paid one forever.
 *
 * Deleting this route is the last step of the RevenueCat migration — see
 * docs/design/revenuecat-implementation.md.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!isTestPurchaseAllowed(user.email)) {
      // Same 403 whether the allowlist is empty or the address simply is not on
      // it. Nothing here should confirm that the mechanism exists.
      throw new ForbiddenError();
    }

    const { productId } = schema.parse(await req.json());
    if (!isProductId(productId)) {
      return Response.json({ error: 'Unknown product' }, { status: 400 });
    }
    const product = productById(productId);

    const periodEnd = new Date();
    if (product.period === 'year') periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

    await upsertSubscription({
      userId: user.id,
      status: 'active',
      source: 'fake',
      productId: product.id,
      currentPeriodEnd: periodEnd,
      autoRenew: true,
    });

    // Written through the same ledger a real webhook uses, so the admin panel's
    // event log tells the true story of how this account became entitled.
    await db
      .insert(subscriptionEvents)
      .values({
        eventId: `fake:${user.id}:${Date.now()}`,
        userId: user.id,
        type: 'FAKE_PURCHASE',
        eventTimeMs: Date.now(),
        payload: { productId: product.id, grantedTo: user.email },
        outcome: 'applied',
      })
      .onConflictDoNothing();

    console.warn(
      `[purchase/test] FAKE subscription granted to ${user.email} (${product.id}) — no money changed hands.`
    );

    return Response.json({ ok: true, productId: product.id, currentPeriodEnd: periodEnd });
  } catch (err) {
    return errorResponse(err);
  }
}
