import { requireUser, errorResponse } from '@/server/auth/guards';
import { getAccountVerdict, isProductId, productById, PRODUCTS } from '@/server/payments';
import { paywallCopy } from '@/server/payments/copy';
import { isTestPurchaseAllowed } from '@/server/payments/testPurchase';
import type { EntitlementPayload } from '@/types/entitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the app asks on launch, and after any purchase.
 *
 * Ungated on purpose — the whole point is that a paywalled user can still get
 * an answer, otherwise the client has no way to learn WHY it is blocked.
 * `requireUser`, not `requireEntitledUser`.
 *
 * The copy travels with the verdict rather than living in the binary, so the
 * paywall's wording can change without a TestFlight build.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const verdict = await getAccountVerdict(user.id);
    const copy = paywallCopy(verdict);

    const payload: EntitlementPayload = {
      state: verdict.state,
      entitled: verdict.entitled,
      canViewExistingTrips: verdict.canViewExistingTrips,
      blockReason: verdict.blockReason,
      trialEndsAt: verdict.trialEndsAt?.toISOString() ?? null,
      trialDaysRemaining: daysUntil(verdict.trialEndsAt),
      paywall: copy,
      /**
       * Sent in EVERY state, entitled included.
       *
       * This used to be empty for an entitled user, on the argument that a
       * client holding no prices cannot accidentally render a purchase sheet.
       * That argument quietly removed the only route App Review has to the
       * in-app purchase. A reviewer signs in with their own Apple ID — which is
       * exactly what `docs/design/app-store-listing.md` instructs, and the
       * right answer to guideline 2.1(a) — and lands in a fresh seven-day
       * trial. Every surface that can open the purchase sheet is gated on NOT
       * being entitled, so with no prices in the payload there is no screen in
       * the app that shows a price and no way to complete a sandbox purchase.
       * That is the "we were unable to locate the in-app purchases" rejection,
       * and no review note can write around it.
       *
       * The property that was being protected still holds, in the place that
       * owns it: the three surfaces that SELL each gate themselves.
       * `PlanRequiredOverlay` returns null for an entitled payload,
       * `mobile/app/paywall.tsx` redirects to /trips, and Penny's bubble is
       * flagged by the server. The one surface that opens the sheet
       * deliberately in every state is Settings -> Plan -> "View plans", which
       * is where a reviewer is sent and where a trial user who wants to commit
       * early goes.
       *
       * Nothing here is a secret: two public prices already printed on the
       * marketing site and in the App Store listing.
       */
      products: PRODUCTS.map((p) => ({
        id: p.id,
        priceLabel: p.priceLabel,
        cadence: p.cadence,
        note: p.period === 'year' ? 'Save $4 a year' : undefined,
      })),
      testPurchaseAllowed: !verdict.entitled && isTestPurchaseAllowed(user.email),
      /**
       * Which plan, and until when — the two facts a subscriber opens Settings
       * to check, and neither of which used to be on the wire. Both were on the
       * `subscriptions` row the whole time; `getAccountVerdict` simply did not
       * select the product and `AccountVerdict` dropped all three.
       *
       * `plan` is derived HERE, from `PRODUCTS`, so the bundle id never crosses
       * the wire. A client matching on `…app.annual` would be a second place
       * that decides what a product is, and it would go wrong quietly the first
       * time a product id changed.
       */
      plan: planFor(verdict.productId),
      currentPeriodEnd: verdict.currentPeriodEnd?.toISOString() ?? null,
      autoRenew: verdict.autoRenew,
      source: verdict.source,
    };

    return Response.json(payload, {
      // Never cached. A stale entitlement is either a paywall shown to someone
      // who just paid, or access left open to someone who did not.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Store product id -> the word the client renders.
 *
 * Null for anything unrecognised as well as for null, deliberately: an admin
 * grant and a promo both carry no product, and a product id we have retired
 * should degrade to "Subscribed" rather than to a guess.
 */
function planFor(productId: string | null): 'monthly' | 'annual' | null {
  if (!productId || !isProductId(productId)) return null;
  return productById(productId).period === 'year' ? 'annual' : 'monthly';
}

/** Whole days left, rounded up, floored at 0. Penny's greeting says "seven". */
function daysUntil(when: Date | null): number {
  if (!when) return 0;
  const ms = when.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}
