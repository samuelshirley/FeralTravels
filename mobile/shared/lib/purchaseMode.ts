import type { PaywallProduct, SubscriptionSource, AccountState } from '../types/entitlement';
import { canManageAppleSubscription } from '../types/entitlement';

/**
 * How the purchase sheet can take money, decided ONCE from two inputs and
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
  /** Apple's localized price string, e.g. "$2.69", "2,00 €". For display only. */
  priceLabel: string;
  /** The same price as a number, in `currencyCode` — what arithmetic uses. */
  price: number;
  /** ISO 4217, from the store: "USD", "EUR", "CAD". */
  currencyCode: string;
}

/**
 * There is no `test` mode any more: the allowlisted fake purchase it rendered
 * was removed on 2026-09-21 — after the production wipe the RevenueCat webhook
 * is the only thing that may grant access.
 */
export type PurchaseMode = 'store' | 'unavailable';

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
  storeAnswer,
  serverPlans,
  locale,
}: {
  storeAnswer: StoreAnswer;
  /** `entitlement.products`, or [] when there is no entitlement payload. */
  serverPlans: PaywallProduct[];
  /** BCP 47 locale for the saving's formatting. Omitted = the device's own. */
  locale?: string;
}): ResolvedPurchaseMode {
  if (storeAnswer.kind === 'pending') {
    return {
      mode: 'unavailable',
      unavailableReason: null,
      plans: withoutNotes(serverPlans),
      plansLoading: true,
    };
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
  const storeFor = (p: PaywallProduct) => storeAnswer.plans.find((s) => s.productId === p.id);
  const monthly = serverPlans.find((p) => p.period === 'month');
  const annual = serverPlans.find((p) => p.period === 'year');
  const monthlyStore = monthly && storeFor(monthly);
  const annualStore = annual && storeFor(annual);
  const saving =
    monthlyStore && annualStore ? annualSavingsNote(monthlyStore, annualStore, locale) : undefined;

  // Any `note` the payload carried is dropped: only the store's own prices may
  // produce one.
  const merged: PaywallProduct[] = withoutNotes(serverPlans).flatMap((p) => {
    const store = storeFor(p);
    if (!store) return [];
    const note = p.period === 'year' ? saving : undefined;
    return [{ ...p, priceLabel: store.priceLabel, ...(note ? { note } : {}) }];
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
  return {
    mode: 'unavailable',
    unavailableReason: reason,
    plans: withoutNotes(serverPlans),
    plansLoading: false,
  };
}

/**
 * No saving without the store. The server's fallback labels are US prices — a
 * rough indication of cost, wrong in every other storefront — and a sum over
 * them would be a precise-looking number that is not true for the reader.
 */
function withoutNotes(plans: PaywallProduct[]): PaywallProduct[] {
  return plans.map(({ note: _ignored, ...rest }) => {
    void _ignored;
    return rest;
  });
}

/**
 * "Save €4 a year", from the STORE's two prices: monthly × 12 − annual, in the
 * store's currency, formatted for the viewer's locale.
 *
 * Every figure comes from StoreKit, so a price changed in App Store Connect is
 * reflected here with no code change. The currency sign comes from
 * `Intl.NumberFormat`, never from us: EUR in `en-IE` is "€4", in `de-DE`
 * "4 €"; CAD is "CA$6" to a US-English reader and "$6" to a Canadian one,
 * which is how each of them writes it.
 *
 * A whole saving drops the decimals ("€4", not "€4.00"), the way the prices
 * themselves are advertised; anything else keeps the currency's own
 * ("$10.28"). The cents test runs on the value rounded to cents, so float
 * noise (2.69 × 12 is 32.279999…) cannot decide it.
 *
 * Returns undefined — no badge — whenever there is no honest figure: the two
 * prices in different currencies, a price that is not a finite number, a
 * currency code that is not ISO 4217-shaped, or an annual plan that does not
 * actually save anything.
 */
export function annualSavingsNote(
  monthly: Pick<StorePlanLike, 'price' | 'currencyCode'>,
  annual: Pick<StorePlanLike, 'price' | 'currencyCode'>,
  locale?: string
): string | undefined {
  const currency = annual.currencyCode;
  if (monthly.currencyCode !== currency || !/^[A-Z]{3}$/.test(currency)) return undefined;
  if (!Number.isFinite(monthly.price) || !Number.isFinite(annual.price)) return undefined;

  const cents = Math.round((monthly.price * 12 - annual.price) * 100);
  if (cents <= 0) return undefined;

  const whole = cents % 100 === 0;
  const amount = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(cents / 100);
  return `Save ${amount} a year`;
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
