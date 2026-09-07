import type { PaywallProduct, SubscriptionSource, AccountState } from '../types/entitlement';
import { canManageAppleSubscription } from '../types/entitlement';

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
 * The sheet used to collapse every way of ending up with nothing to sell into
 * one sentence — "The App Store isn't offering these plans on this build yet"
 * — and that sentence was rendered for FOUR different failures which need four
 * different fixes, three of them ours:
 *
 *   `no_key`       the build has no RevenueCat key. Nothing was asked of
 *                  anybody. Fix: `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in eas.json
 *                  and a new native build (compiled in, an OTA cannot fix it).
 *   `store_empty`  RevenueCat answered with an offering that has no packages.
 *                  StoreKit could not resolve the products — in practice the
 *                  Paid Applications Agreement is not Active, or the products
 *                  are in Missing Metadata. Fix: App Store Connect, not code.
 *   `store_error`  the offerings call THREW: no network, a rejected key, a
 *                  RevenueCat outage. Fix: try again, or check the key.
 *   `no_match`     RevenueCat returned packages, and not one of their product
 *                  ids matches a plan the server sells. Fix: the ids in the
 *                  RevenueCat dashboard, or `PRODUCTS` in constants.ts.
 *   `no_plans`     the SERVER gave us nothing to sell — the entitlement fetch
 *                  failed, so there is no list to intersect with. Fix: network.
 *
 * Telling the reader which one it is costs nothing and is the difference
 * between "sign the agreement" and "rebuild the app" — which was found out the
 * slow way (docs/design/iap-setup.md §1 and §5 describe the same blank sheet).
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
 * The sentence under the plan rows in `unavailable` mode, one per reason,
 * sharing no string. Each says what the reader can do — which for the three
 * that are OUR paperwork is "nothing, but Restore still works if you paid",
 * except `no_key`, where Restore cannot work either and saying it would is a
 * lie: the SDK was never configured, so `restore()` refuses too.
 */
export function unavailableMessage(reason: UnavailableReason): string {
  switch (reason) {
    case 'no_key':
      return (
        "This build isn't connected to the App Store, so nothing here can be bought or restored " +
        'yet. These are the prices, not a checkout.'
      );
    case 'store_empty':
      return (
        "The App Store isn't offering these plans yet — these are the prices, not a checkout. " +
        'If you already have a plan, Restore purchases will still find it.'
      );
    case 'store_error':
      return (
        "The App Store couldn't be reached just now — these are the prices, not a checkout. " +
        'Try again in a moment, or use Restore purchases if you already have a plan.'
      );
    case 'no_match':
      return (
        'The App Store is offering different plans from the ones this app expects, so nothing ' +
        'here can be bought. If you already have a plan, Restore purchases will still find it.'
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
