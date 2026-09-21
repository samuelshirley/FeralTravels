import type { PaywallProduct, SubscriptionSource, AccountState } from '@/types/entitlement';
import { canManageAppleSubscription } from '@/types/entitlement';

/**
 * How the purchase sheet can take money, decided ONCE from three inputs and
 * rendered rather than re-derived by each surface.
 *
 * Pure, and mirrored into the Expo app by `scripts/sync-shared.mjs`, so the
 * decision can be unit-tested here (`mobile/` has no test runner) and rendered
 * there. `mobile/lib/purchaseFlow.ts` is the only caller.
 *
 * ── Why "unavailable" carries a REASON ────────────────────────────────────
 *
 * Five different failures end in the same sheet, and four of the fixes are
 * ours:
 *
 *   `no_key`       the build has no RevenueCat key. Nothing was asked of
 *                  anybody. Fix: `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in eas.json
 *                  and a new native build (compiled in, an OTA cannot fix it).
 *                  `mobile/app.config.js` refuses to make a preview or
 *                  production EAS build without it.
 *   `store_empty`  RevenueCat served the offering, and StoreKit resolved NONE
 *                  of its products. `getStorePlans()` reports this both when
 *                  the SDK throws CONFIGURATION_ERROR (what it actually does
 *                  when every product is invalid) and when the offering has no
 *                  packages. Fix: App Store Connect, not code —
 *                  `scripts/storekit-probe.sh` asks StoreKit directly.
 *   `store_error`  the offerings call THREW anything else: no network, a
 *                  rejected key, a RevenueCat outage. Fix: try again, or check
 *                  the key.
 *   `no_match`     RevenueCat returned packages, and not one of their product
 *                  ids matches a plan the server sells. Fix: the ids in the
 *                  RevenueCat dashboard, or `PRODUCTS` in constants.ts.
 *   `no_plans`     the SERVER gave us nothing to sell — the entitlement fetch
 *                  failed, so there is no list to intersect with. Fix: network.
 *
 * ── Who is told which ─────────────────────────────────────────────────────
 *
 * The REASON is for us; the customer only needs to know what THEY can do.
 * `unavailableMessage` below is the customer's copy and never names our
 * paperwork — a sentence telling an App Review tester that the store is not
 * selling these plans YET is a rejection. The five-way developer reading lives in
 * `purchaseDiagnostics.ts`, which a release build does not contain at all.
 * `purchaseCopyGuard.test.ts` holds both halves of that.
 */

/** What the store said, as far as the flow has heard so far. */
export type StoreAnswer =
  /** The offerings request is in flight (or has not been sent yet). */
  | { kind: 'pending' }
  /** This build carries no RevenueCat key; the SDK was never configured. */
  | { kind: 'no_key' }
  /** The store answered. `plans` may legitimately be empty. */
  | { kind: 'packages'; plans: StorePlanLike[] }
  /** The offerings request threw. */
  | { kind: 'error' };

/**
 * The store's view of one plan — the shape `mobile/lib/purchases.ts` produces.
 * Declared here so the shared module does not import from a file that imports
 * `react-native-purchases`.
 */
export interface StorePlanLike {
  productId: string;
  /** Apple's localized price string, e.g. "$2.00", "€2,49". */
  priceLabel: string;
}

export type PurchaseMode = 'test' | 'store' | 'unavailable';

export type UnavailableReason =
  | 'no_key'
  | 'store_empty'
  | 'store_error'
  | 'no_match'
  | 'no_plans';

export interface ResolvedPurchaseMode {
  mode: PurchaseMode;
  /** Set only when `mode === 'unavailable'`. */
  unavailableReason: UnavailableReason | null;
  /**
   * What to render, in the server's order. In `store` mode these carry the
   * store's prices; otherwise they are the server's fallback strings.
   */
  plans: PaywallProduct[];
  /** True while the store has not answered yet (and there is a store to ask). */
  plansLoading: boolean;
}

export function resolvePurchaseMode({
  testMode,
  storeAnswer,
  serverPlans,
}: {
  /** The server said this account may use the fake purchase path. */
  testMode: boolean;
  storeAnswer: StoreAnswer;
  /** `entitlement.products`, or [] when there is no entitlement payload. */
  serverPlans: PaywallProduct[];
}): ResolvedPurchaseMode {
  // The allowlisted path wins over the store on purpose: that account exists
  // precisely to walk the paywall without Apple. The store is never even asked.
  if (testMode) {
    return { mode: 'test', unavailableReason: null, plans: serverPlans, plansLoading: false };
  }

  if (storeAnswer.kind === 'pending') {
    return { mode: 'unavailable', unavailableReason: null, plans: serverPlans, plansLoading: true };
  }

  if (storeAnswer.kind === 'no_key') {
    return unavailable('no_key', serverPlans);
  }

  if (storeAnswer.kind === 'error') {
    return unavailable('store_error', serverPlans);
  }

  if (serverPlans.length === 0) {
    return unavailable('no_plans', serverPlans);
  }

  if (storeAnswer.plans.length === 0) {
    return unavailable('store_empty', serverPlans);
  }

  /**
   * The server decides WHAT is for sale and how it reads; the store decides
   * what it COSTS. Merged in the server's order so the cadence, the note and
   * the ordering stay server-authored, while `priceLabel` becomes Apple's own
   * localized string.
   *
   * A server plan with no matching store package is DROPPED: Apple cannot sell
   * it, so offering it would produce a tap that can only fail. ONE plan
   * surviving where there should be two is left exactly as it is — that
   * asymmetry is diagnostic (a single mistyped product id looks like this).
   * NONE surviving is a different failure and gets its own reason.
   */
  const merged: PaywallProduct[] = serverPlans.flatMap((p) => {
    const store = storeAnswer.plans.find((s) => s.productId === p.id);
    return store ? [{ ...p, priceLabel: store.priceLabel }] : [];
  });

  if (merged.length === 0) {
    return unavailable('no_match', serverPlans);
  }

  return { mode: 'store', unavailableReason: null, plans: merged, plansLoading: false };
}

function unavailable(
  reason: UnavailableReason,
  serverPlans: PaywallProduct[]
): ResolvedPurchaseMode {
  // The fallback prices are still rendered: the reader learns what a plan
  // costs, roughly, and the sentence under them says why it cannot be bought
  // here. An empty sheet would say nothing at all.
  return { mode: 'unavailable', unavailableReason: reason, plans: serverPlans, plansLoading: false };
}

/**
 * The CUSTOMER's sentence under the plan rows in `unavailable` mode.
 *
 * It says what the reader can do, and nothing about why we cannot sell: the
 * three reasons that are our own configuration (`no_key`, `store_empty`,
 * `no_match`) deliberately share one line, because the difference between them
 * is ours to diagnose, not theirs — see `purchaseDiagnostics.ts`, which a dev
 * build shows beneath this line. The two the reader CAN act on (the store or
 * our API could not be reached) say "try again".
 *
 * Restore is offered in every case but `no_key`, where the SDK was never
 * configured and `restore()` refuses too; promising it would be a lie to
 * exactly the person who paid. (`no_key` cannot reach a customer anyway —
 * app.config.js refuses the build — but the copy stays true if it ever did.)
 *
 * Words a reviewer must never read here — "yet", "not a checkout", "this
 * build", anything about App Store Connect — are listed in
 * `purchaseCopyGuard.test.ts`.
 */
export function unavailableMessage(reason: UnavailableReason): string {
  switch (reason) {
    case 'no_key':
      return (
        "Plans can't be bought on this device right now. Email support@feraltravels.com and " +
        "we'll sort it out."
      );
    case 'store_empty':
    case 'no_match':
      return (
        "Plans can't be bought on this device right now. If you already have a plan, Restore " +
        'purchases will find it.'
      );
    case 'store_error':
      return (
        "Couldn't reach the App Store. Try again in a moment, or use Restore purchases if you " +
        'already have a plan.'
      );
    case 'no_plans':
      return (
        "Couldn't load the plans — check your connection and reopen this sheet. If you already " +
        'have a plan, Restore purchases will still find it.'
      );
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Whether the "Manage subscription" link (Apple's own subscriptions screen)
 * should be on screen for this account. Re-exported from the entitlement
 * types so the flow has one import; the rule itself lives beside the state
 * type — see `canManageAppleSubscription`.
 */
export function manageSubscriptionAvailable(
  entitlement: { state: AccountState; source: SubscriptionSource | null } | null
): boolean {
  // Unknown state (the fetch failed) hides it: the link is only useful to an
  // account that has a subscription with Apple, and we do not know that. The
  // subscriber this could inconvenience still has iOS Settings; the trial
  // user it protects would otherwise be sent to an empty list.
  if (!entitlement) return false;
  return canManageAppleSubscription(entitlement.state, entitlement.source);
}
