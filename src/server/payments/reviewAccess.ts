import type { AccountVerdict } from './states';

/**
 * App Review's demo account is always entitled — the pure half.
 *
 * The incident (device check against production, 2026-10-20): signing in as
 * the review account (`appletest@feraltravels.com`, armed by
 * `APPLE_REVIEW_SIGNIN=1`, see `server/auth/reviewAccount.ts`) landed on
 * "Planning is paused — That's your seven days up". The account was created
 * more than seven days before review, so its free period was over and the
 * reviewer could not use the app without buying: a Guideline 2.1 rejection
 * ("provide a demo account with full access").
 *
 * The rule: while armed, that ONE account is entitled whatever its state, the
 * same way the paywall master switch loosens a verdict — only the three
 * fields that gate behaviour change. The STATE is left as the resolver found
 * it, deliberately:
 *
 *  - No subscription row is written or pretended. A fake row would be a
 *    second, lying source of "has paid"; this is a decision about access.
 *  - The reviewer can still buy. Settings -> Plan -> View plans opens the
 *    sheet in every state, and after a sandbox purchase the RevenueCat webhook
 *    writes a real `apple_iap` row, the state becomes `subscribed`, and the
 *    app's post-purchase wait (`appleSubscriptionConfirmed`) sees it. Turning
 *    the account into `comped` instead would mask that row and the purchase
 *    would appear to do nothing.
 *
 * Every state is loosened, `refunded` and `revoked` included: a reviewer who
 * asks Apple for a sandbox refund must not lock themselves out mid-review.
 * `APPLE_REVIEW_SIGNIN` turns the whole thing off, from the dashboard.
 */
export function applyReviewAccess(verdict: AccountVerdict, isReviewAccount: boolean): AccountVerdict {
  if (!isReviewAccount) return verdict;
  return { ...verdict, entitled: true, canViewExistingTrips: true, blockReason: null };
}
