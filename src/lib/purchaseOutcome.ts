/**
 * What a StoreKit purchase attempt can end as, and what we say about it.
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs`, which is the only
 * reason it lives under `src/lib/` at all: nothing on the web can buy anything.
 * It is here so the vocabulary and the copy are unit-tested by the root suite —
 * `mobile/` has no test runner, and CI's unit job never installs
 * `mobile/node_modules`, so a module that imports `react-native-purchases`
 * cannot be tested anywhere. Same trade `paywallNotice.ts` makes.
 *
 * The SPLIT that matters: this file owns the vocabulary and the words. The
 * mapping from RevenueCat's `PURCHASES_ERROR_CODE` to one of these lives in
 * `mobile/lib/purchases.ts`, next to the import of the enum itself, so
 * `tsc --noEmit` in `mobile/` (the Mobile typecheck CI job) fails if RevenueCat
 * renames a member. A copy of those enum names over here would be a copy
 * nothing checks.
 *
 * A PURCHASE IS NOT AN ENTITLEMENT. Nothing in this file grants access — the
 * RevenueCat webhook is the only thing that can, and `purchased` below means
 * only "Apple took the money", which is the moment the app starts WAITING for
 * the server rather than the moment it unlocks. See `entitlementPolling.ts`.
 */

/** Why a purchase failed, once the store-specific code has been read. */
export type PurchaseFailureReason =
  /** The device could not reach the App Store. Retrying is the fix. */
  | 'network'
  /** The App Store itself answered badly. Not the user, not us. */
  | 'store'
  /** Screen Time / MDM restrictions forbid purchases on this device. */
  | 'not_allowed'
  /** Apple could not charge the payment method on file. */
  | 'payment_invalid'
  /**
   * The store has no such product to sell. In practice this is almost always
   * OUR paperwork, not the user's problem — see docs/design/iap-setup.md.
   */
  | 'unavailable'
  /** The RevenueCat key or dashboard is wrong. A build/config bug. */
  | 'misconfigured'
  /** Anything else. */
  | 'unknown';

export type PurchaseOutcome =
  /**
   * Apple took the payment. NOT "the user is entitled" — our server has not
   * heard about it yet and may not for a few seconds.
   */
  | { kind: 'purchased'; productId: string }
  /** They backed out of Apple's sheet. Deliberate, and not an error. */
  | { kind: 'cancelled' }
  /**
   * Ask to Buy, or any other deferred payment: Apple is holding the purchase
   * until somebody approves it. There is no entitlement and there is no
   * failure. Treating this as an error is the classic bug — it tells a child's
   * parent that something broke while the request sits in their queue.
   */
  | { kind: 'pending' }
  /**
   * This Apple ID already owns the subscription. It usually means a reinstall
   * or a second account, and the answer is Restore, not another charge.
   */
  | { kind: 'already_owned' }
  | { kind: 'failed'; reason: PurchaseFailureReason };

/** What a restore attempt can end as. */
export type RestoreOutcome =
  /** The Apple ID had a subscription and RevenueCat has re-attached it. */
  | { kind: 'restored' }
  /** It completed and found nothing. Not an error — just no purchase to find. */
  | { kind: 'nothing_to_restore' }
  | { kind: 'failed'; reason: PurchaseFailureReason };

/**
 * One line per outcome, and none of them accuses the reader.
 *
 * Same rule as `promoCopy.ts` and the `usage_cap` paywall message: when the
 * failure is ours or Apple's, say so plainly rather than implying the user did
 * something wrong. `cancelled` has no copy at all — they closed the sheet on
 * purpose, and telling them so is noise.
 */
const FAILURE_COPY: Record<PurchaseFailureReason, string> = {
  network:
    "Couldn't reach the App Store. Check your connection and try again — nothing was charged.",
  store: 'The App Store had a problem with that. Nothing was charged; try again in a moment.',
  not_allowed:
    "This device isn't allowed to make purchases. That's a Screen Time or device-management " +
    'setting, not your account.',
  payment_invalid:
    "The App Store couldn't complete the payment. You can check your payment method in " +
    'Settings › Apple Account.',
  unavailable:
    "That plan isn't available from the App Store right now. That's on us, not you — get in " +
    'touch and we\'ll sort it out.',
  misconfigured:
    "Purchasing isn't set up correctly in this build. That's our bug — please tell us and " +
    "we'll fix it.",
  unknown: "That didn't go through, and nothing was charged. Try again in a moment.",
};

/**
 * What to show the user, or null when the outcome speaks for itself.
 *
 * Returns null for `purchased` and `cancelled` on purpose: the first is
 * followed by the waiting state below, and the second is the user closing a
 * sheet they opened.
 */
export function purchaseOutcomeMessage(outcome: PurchaseOutcome): string | null {
  switch (outcome.kind) {
    case 'purchased':
    case 'cancelled':
      return null;
    case 'pending':
      return (
        'That purchase needs approval before it can go through — Apple will ask whoever ' +
        "manages this account. Nothing is charged until they say yes, and I'll switch on as " +
        'soon as it lands.'
      );
    case 'already_owned':
      return (
        'This Apple ID already has a plan. Tap Restore purchases to put it back on this ' +
        'account — you will not be charged twice.'
      );
    case 'failed':
      return FAILURE_COPY[outcome.reason];
  }
}

export function restoreOutcomeMessage(outcome: RestoreOutcome): string | null {
  switch (outcome.kind) {
    case 'restored':
      return null;
    case 'nothing_to_restore':
      return (
        "This Apple ID doesn't have a plan on it. If you bought one with a different Apple ID, " +
        'sign in to that one in Settings › Apple Account and try again.'
      );
    case 'failed':
      return FAILURE_COPY[outcome.reason];
  }
}

/**
 * Shown while the app is waiting for the RevenueCat webhook to reach our
 * server. It has to say the money part first: the charge is already real and
 * the user has just watched Apple confirm it, so anything that reads like
 * "processing…" invites them to buy again.
 */
export const PURCHASE_CONFIRMING_MESSAGE = 'Payment received — switching your plan on…';

/**
 * Shown when the poll gives up. The purchase is REAL and this message must
 * never suggest otherwise; what it offers is the two things that actually
 * help, in order of how likely they are to work.
 */
export const PURCHASE_CONFIRM_TIMEOUT_MESSAGE =
  'Your purchase went through and Apple has it. Switching your plan on is taking longer than ' +
  'usual — it normally lands within a minute or two. Reopen the app shortly, or tap Restore ' +
  'purchases. You have not been charged twice.';

/**
 * Apple's own deep link to the Manage Subscriptions screen.
 *
 * `itms-apps:` rather than `https://apps.apple.com/...`: the https form opens
 * the App Store app and then bounces to the account screen, which on some iOS
 * versions lands on the account root instead of the subscription list. This
 * scheme is the one Apple documents for the purpose, and it is inert on any
 * platform that cannot handle it (the app is iOS-only today).
 */
export const MANAGE_SUBSCRIPTIONS_URL = 'itms-apps://apps.apple.com/account/subscriptions';
