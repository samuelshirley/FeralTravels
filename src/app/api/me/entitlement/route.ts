import { requireUser, errorResponse } from '@/server/auth/guards';
import { getAccountVerdict, PRODUCTS } from '@/server/payments';
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
      // Empty for an entitled user: there is nothing to sell them, and a
      // client that has no prices cannot accidentally render a purchase sheet.
      products: verdict.entitled
        ? []
        : PRODUCTS.map((p) => ({
            id: p.id,
            priceLabel: p.priceLabel,
            cadence: p.cadence,
            note: p.period === 'year' ? 'Save $4 a year' : undefined,
          })),
      testPurchaseAllowed: !verdict.entitled && isTestPurchaseAllowed(user.email),
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

/** Whole days left, rounded up, floored at 0. Penny's greeting says "seven". */
function daysUntil(when: Date | null): number {
  if (!when) return 0;
  const ms = when.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}
