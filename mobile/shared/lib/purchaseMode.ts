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
  /**
   * The product's localized display name from App Store Connect, e.g. "Feral
   * Travels monthly". May be blank if the metadata is missing; the merge then
   * keeps the server's title, so a row is never untitled.
   */
  title: string;
  /**
   * Apple's localized price string, e.g. "$2.69", "2,00 €". For display only.
   * A blank one drops the plan: the sheet never prints a price the store did
   * not give it.
   */
  priceLabel: string;
  /** The same price as a number, in `currencyCode` — what arithmetic uses. */
  price: number;
  /** ISO 4217, from the store: "USD", "EUR", "CAD". */
  currencyCode: string;
  /**
   * RevenueCat's `product.pricePerMonthString`: the price over one month,
   * formatted by StoreKit's own formatter ("$1.83" for $22.00 a year). Null
   * for a product RevenueCat cannot spread (not a subscription).
   */
  pricePerMonthLabel: string | null;
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

/**
 * One row of the purchase sheet: everything Guideline 3.1.2(c) wants beside the
 * control that buys it — the subscription's title, its length, and its price —
 * plus, for the annual plan, what that works out to per month.
 *
 * Built ONLY by the store branch of `resolvePurchaseMode`, from a StoreKit
 * answer. There is no constructor that takes the server's fallback strings, so
 * a sheet cannot print "$2.69" in front of somebody Apple will charge €2.
 */
export interface SheetPlan {
  id: string;
  /** App Store Connect's localized display name; the server's when blank. */
  title: string;
  period: 'month' | 'year';
  /** "1 month" / "1 year" — the subscription's length, said outright. */
  length: string;
  /** Server-authored, e.g. "per month". */
  cadence: string;
  /** Apple's `priceString`. Never the server's fallback. */
  priceLabel: string;
  /**
   * Annual only: "$1.83/month, billed annually", from StoreKit's
   * `pricePerMonthString`. Absent when the store gave no per-month figure.
   */
  perMonth?: string;
  /** The annual saving, from the store's two prices — see `annualSavingsNote`. */
  note?: string;
}

/**
 * The two shapes the sheet can be in. A discriminated union rather than one
 * record with a mode flag, so that "unavailable with plan rows" is not a value
 * this type can hold: `plans` is the empty tuple there, and `tsc` refuses any
 * branch that tries to hand the sheet a row without a store answer behind it.
 *
 * That is the 2026-10-20 fix. Unavailable mode used to render the server's
 * `fallbackUsdLabel` ("$2.69", "$22.00") with no renewal terms — a price that
 * is wrong in every storefront but one, beside nothing Apple wants with it.
 */
export type ResolvedPurchaseMode =
  | {
      mode: 'store';
      unavailableReason: null;
      plans: SheetPlan[];
      plansLoading: false;
    }
  | {
      mode: 'unavailable';
      /** Null only while the store is still being asked. */
      unavailableReason: UnavailableReason | null;
      plans: readonly [];
      /** True while the store has not answered yet (and there is a store to ask). */
      plansLoading: boolean;
    };

/** The subscription's length, from its period. Exhaustive, so a third period fails `tsc`. */
export function planLength(period: SheetPlan['period']): string {
  switch (period) {
    case 'month':
      return '1 month';
    case 'year':
      return '1 year';
    default: {
      const exhaustive: never = period;
      return exhaustive;
    }
  }
}

export function resolvePurchaseMode({
  storeAnswer,
  serverPlans,
  locale,
}: {
  storeAnswer: StoreAnswer;
  /** `entitlement.products`, or [] when there is no entitlement payload. */
  serverPlans: PaywallProduct[];
  /**
   * The device's BCP 47 locale, tried FIRST when working out how the storefront
   * writes a price (see `annualSavingsNote`). It never decides the format by
   * itself. Omitted = the runtime's default.
   */
  locale?: string;
}): ResolvedPurchaseMode {
  if (storeAnswer.kind === 'pending') {
    return { mode: 'unavailable', unavailableReason: null, plans: [], plansLoading: true };
  }

  if (storeAnswer.kind === 'no_key') {
    return unavailable('no_key');
  }

  if (storeAnswer.kind === 'error') {
    return unavailable('store_error');
  }

  if (serverPlans.length === 0) {
    return unavailable('no_plans');
  }

  // A package whose price string is blank is a package with no price to show.
  // It is treated as absent rather than rendered with an empty price — the sheet
  // prints only what the store said.
  const priced = storeAnswer.plans.filter((s) => s.priceLabel.trim() !== '');
  if (priced.length === 0) {
    return unavailable('store_empty');
  }

  /**
   * The server decides WHAT is for sale and how it reads; the store decides
   * what it COSTS and what it is CALLED. Merged in the server's order so the
   * cadence and the ordering stay server-authored, while `priceLabel` and
   * `title` become Apple's own localized strings — the title falling back to
   * the server's when the store's is blank, because an untitled row is the
   * Guideline 3.1.2(c) rejection of 2026-10-19.
   *
   * A server plan with no matching store package is DROPPED: Apple cannot sell
   * it, so offering it would produce a tap that can only fail. ONE plan
   * surviving where there should be two is left exactly as it is — that
   * asymmetry is diagnostic (a single mistyped product id looks like this).
   * NONE surviving is a different failure and gets its own reason.
   */
  const storeFor = (p: PaywallProduct) => priced.find((s) => s.productId === p.id);
  const monthly = serverPlans.find((p) => p.period === 'month');
  const annual = serverPlans.find((p) => p.period === 'year');
  const monthlyStore = monthly && storeFor(monthly);
  const annualStore = annual && storeFor(annual);
  const saving =
    monthlyStore && annualStore ? annualSavingsNote(monthlyStore, annualStore, locale) : undefined;

  // Built field by field rather than spread from the server's product, so
  // nothing the payload carries — its fallback `priceLabel`, a stale `note` —
  // can ride through onto the sheet.
  const merged: SheetPlan[] = serverPlans.flatMap((p) => {
    const store = storeFor(p);
    if (!store) return [];
    const perMonthLabel = store.pricePerMonthLabel?.trim();
    const row: SheetPlan = {
      id: p.id,
      title: store.title?.trim() || p.title,
      period: p.period,
      length: planLength(p.period),
      cadence: p.cadence,
      priceLabel: store.priceLabel,
    };
    if (p.period === 'year' && perMonthLabel) row.perMonth = `${perMonthLabel}/month, billed annually`;
    if (p.period === 'year' && saving) row.note = saving;
    return [row];
  });

  if (merged.length === 0) {
    return unavailable('no_match');
  }

  return { mode: 'store', unavailableReason: null, plans: merged, plansLoading: false };
}

/**
 * No rows at all. The server's fallback prices are US prices — wrong in every
 * other storefront — and an unavailable sheet cannot say what the renewal
 * terms are for a price it cannot sell. The sheet shows the reason, Restore and
 * the legal links instead (`unavailableMessage`).
 */
function unavailable(reason: UnavailableReason): ResolvedPurchaseMode {
  return { mode: 'unavailable', unavailableReason: reason, plans: [], plansLoading: false };
}

/**
 * Locales tried, after the device's own, to find how the STOREFRONT writes a
 * price. The app is sold in the US, Canada and Europe (App Store availability is
 * set to exactly those), so these are each of those regions' languages plus an
 * English variant of each: Apple formats with the App Store account's storefront
 * and language, which need not match the device. A storefront outside this set
 * still matches whenever one of these happens to write its currency the same
 * way; when none does, there is no badge.
 */
const STOREFRONT_LOCALES = [
  'en-US', 'es-US', 'en-CA', 'fr-CA',
  'en-GB', 'en-IE', 'ga-IE', 'en-MT', 'mt-MT',
  'de-DE', 'en-DE', 'de-AT', 'en-AT', 'de-CH', 'fr-CH', 'it-CH', 'en-CH', 'de-LU', 'fr-LU',
  'fr-FR', 'en-FR', 'fr-BE', 'nl-BE', 'en-BE', 'nl-NL', 'en-NL',
  'es-ES', 'ca-ES', 'en-ES', 'pt-PT', 'en-PT', 'it-IT', 'en-IT',
  'sv-SE', 'en-SE', 'da-DK', 'en-DK', 'nb-NO', 'en-NO', 'fi-FI', 'en-FI', 'is-IS',
  'pl-PL', 'en-PL', 'cs-CZ', 'en-CZ', 'sk-SK', 'hu-HU', 'en-HU', 'ro-RO', 'bg-BG',
  'el-GR', 'en-GR', 'el-CY', 'en-CY', 'hr-HR', 'sl-SI', 'en-SI', 'et-EE', 'lv-LV', 'lt-LT',
];

/** Spaces differ between Apple and Intl (U+00A0, U+202F) and say nothing about format. */
const normalizeSpaces = (s: string) => s.replace(/[\s\u00a0\u202f]+/g, ' ').trim();

/**
 * The locale that writes `price` in `currency` EXACTLY as the store's own label
 * does — i.e. the storefront's format — or undefined when none of the
 * candidates reproduces it.
 */
function storefrontLocale(
  price: number,
  currency: string,
  label: string,
  deviceLocale?: string
): string | undefined {
  const target = normalizeSpaces(label);
  const candidates = [...(deviceLocale ? [deviceLocale] : []), ...STOREFRONT_LOCALES];
  for (const candidate of candidates) {
    try {
      const written = new Intl.NumberFormat(candidate, { style: 'currency', currency }).format(price);
      if (normalizeSpaces(written) === target) return candidate;
    } catch {
      // A locale this runtime does not know is simply not a candidate.
    }
  }
  return undefined;
}

/**
 * "Save €4 a year", from the STORE's two prices: monthly × 12 − annual, in the
 * store's currency, written the way the STOREFRONT writes its prices.
 *
 * Every figure comes from StoreKit, so a price changed in App Store Connect is
 * reflected here with no code change. The FORMAT comes from StoreKit too: the
 * badge sits beside Apple's own price string, so it is written in whichever
 * locale reproduces that string exactly. Formatting with the device's locale
 * instead put "Save 10,28 US$ a year" beside "$22.00 per year" on a
 * Spanish-language iPhone with a US App Store account (2026-10-20). The device
 * locale is only tried first, as the likeliest match.
 *
 * A whole saving drops the decimals ("€4", not "€4.00"), the way the prices
 * themselves are advertised; anything else keeps the currency's own
 * ("$10.28"). The cents test runs on the value rounded to cents, so float
 * noise (2.69 × 12 is 32.279999…) cannot decide it.
 *
 * Returns undefined — no badge — whenever there is no honest figure: the two
 * prices in different currencies, a price that is not a finite number, a
 * currency code that is not ISO 4217-shaped, an annual plan that does not
 * actually save anything, or a store label no known locale reproduces (a
 * guessed format beside Apple's is the bug this replaced).
 */
export function annualSavingsNote(
  monthly: Pick<StorePlanLike, 'price' | 'currencyCode'>,
  annual: Pick<StorePlanLike, 'price' | 'currencyCode' | 'priceLabel'>,
  deviceLocale?: string
): string | undefined {
  const currency = annual.currencyCode;
  if (monthly.currencyCode !== currency || !/^[A-Z]{3}$/.test(currency)) return undefined;
  if (!Number.isFinite(monthly.price) || !Number.isFinite(annual.price)) return undefined;

  const cents = Math.round((monthly.price * 12 - annual.price) * 100);
  if (cents <= 0) return undefined;

  const locale = storefrontLocale(annual.price, currency, annual.priceLabel, deviceLocale);
  if (!locale) return undefined;

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

