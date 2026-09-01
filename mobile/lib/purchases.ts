import Purchases, {
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  type PurchasesPackage,
} from "react-native-purchases";
import { getIdentity } from "@/lib/api";
import { getToken, onTokenChange } from "@/lib/auth";
import { REVENUECAT_ENTITLEMENT_ID, REVENUECAT_IOS_KEY } from "@/lib/config";
import type {
  PurchaseFailureReason,
  PurchaseOutcome,
  RestoreOutcome,
} from "@/shared/lib/purchaseOutcome";

/**
 * THE ONLY MODULE IN THIS APP THAT TALKS TO react-native-purchases.
 *
 * Same bounded-module argument as `src/server/payments/`: the number of places
 * able to say "this user bought something" stays at one. Screens import
 * `usePurchaseFlow` from `purchaseFlow.ts`; nothing else imports this file, and
 * nothing at all imports `react-native-purchases` directly.
 *
 * ── What this module does NOT do ───────────────────────────────────────────
 *
 * It does not grant access. `purchasePackage` resolving means Apple took the
 * money; it does not mean our server knows. The entitlement arrives through
 * `POST /api/webhooks/revenuecat`, which is the only thing in the system that
 * may write a `subscriptions` row from a store event, and which is deliberately
 * unable to tell a real purchase from a fake one. A receipt the client holds is
 * a claim, not proof. `purchaseFlow.ts` waits for the server; this file never
 * reports entitlement of its own.
 *
 * ── app_user_id is the whole ballgame ─────────────────────────────────────
 *
 * `src/server/payments/webhook.ts` resolves the buyer with a direct equality
 * join of the event's `app_user_id` against `users.id`. If RevenueCat is
 * carrying anything else — an anonymous `$RCAnonymousID:…`, an email, a session
 * token — every webhook lands as `ignored_unknown_user`, the money is taken and
 * nobody is entitled. It looks identical to working right up until somebody
 * tries to plan a trip.
 *
 * So there are two belts and a brace:
 *
 *  1. `configurePurchases()` subscribes to `onTokenChange`, so every sign-in
 *     and every sign-out — including the automatic `clearToken()` that
 *     `apiFetch` performs on a 401 — logs the SDK in or out. One wiring point
 *     rather than a call in every screen that can sign a user in.
 *  2. `requirePurchaserId()` runs before any purchase or restore and REFUSES
 *     if it cannot confirm the id with the server. Buying anonymously is worse
 *     than not buying: the second is a message on screen, the first is an
 *     unattributable charge.
 *
 * The id comes from `GET /api/me/identity` rather than from the sign-in
 * response, because a restored keychain session has no sign-in response — and
 * that is the state the app is in on every launch after the first.
 */

/** Null until `configurePurchases()` decides there is a key to configure with. */
let configured = false;

/**
 * The `users.id` currently logged in to RevenueCat, so a repeat purchase does
 * not cost a round trip. Cleared on sign-out; never trusted across one.
 */
let identifiedUserId: string | null = null;

/** In-flight identify, so two screens asking at once make one request. */
let identifying: Promise<string> | null = null;

/**
 * Purchasing is only possible when a key was baked into this build.
 *
 * Exported because the purchase sheet has to be able to say so. A buy button
 * that cannot take money is worse than no button, and the honest message
 * ("purchasing isn't wired up yet") is very different from the message for a
 * store that answered with nothing.
 */
export function purchasesAvailable(): boolean {
  return REVENUECAT_IOS_KEY !== null;
}

/**
 * Configure the SDK once, at boot, and wire it to the session.
 *
 * Called from `app/_layout.tsx`. Deliberately synchronous and deliberately
 * un-awaited: `Purchases.configure` returns void, and blocking the first frame
 * on a purchases SDK would be a strange thing to do to somebody opening a trip
 * planner.
 *
 * `configure({ apiKey })` with no `appUserID` — anonymous — is the documented
 * shape, because the keychain read that produces the real id is async and the
 * SDK should not be waiting on it. RevenueCat aliases the anonymous id to the
 * real one on `logIn`, so a purchase made in the gap cannot be stranded. In
 * practice the gap does not exist: nothing in this app can reach a purchase
 * sheet without being signed in, and `requirePurchaserId` refuses anyway.
 */
export function configurePurchases(): void {
  if (configured || !REVENUECAT_IOS_KEY) return;
  configured = true;

  // INFO in release, DEBUG in debug, is the SDK default. Left alone on purpose
  // except in dev, where the one question worth answering from a log is "what
  // app_user_id did it actually send".
  if (__DEV__) void Purchases.setLogLevel(LOG_LEVEL.DEBUG);

  Purchases.configure({ apiKey: REVENUECAT_IOS_KEY });

  // Every sign-in and sign-out in the app funnels through these two, including
  // the 401-triggered `clearToken()` in apiFetch. Subscribing here rather than
  // calling from sign-in.tsx means a future third sign-in path cannot forget.
  onTokenChange((token) => {
    if (token) {
      // Best-effort: a failure here just means the id is resolved later, by
      // `requirePurchaserId`, which is the one that actually gates a purchase.
      void identifyPurchaser().catch(() => {});
    } else {
      identifiedUserId = null;
      identifying = null;
      // logOut throws for an already-anonymous SDK (LOG_OUT_ANONYMOUS_USER_ERROR).
      // Signing out twice is not a problem worth surfacing.
      void Purchases.logOut().catch(() => {});
    }
  });

  // The launch case: a token restored from the keychain fires no listener.
  void getToken().then((token) => {
    if (token) void identifyPurchaser().catch(() => {});
  });
}

/**
 * Tell RevenueCat who this is, and remember it.
 *
 * Idempotent and de-duplicated: repeated calls with the SDK already logged in
 * as this user return immediately without a round trip.
 */
async function identifyPurchaser(): Promise<string> {
  if (!configured) throw new PurchasesUnavailableError();
  if (identifiedUserId) return identifiedUserId;
  if (identifying) return identifying;

  identifying = (async () => {
    const identity = await getIdentity();
    if (!identity.id) {
      // The route answered but had no row — a session that outlived its user.
      throw new PurchaserUnknownError();
    }
    await Purchases.logIn(identity.id);
    identifiedUserId = identity.id;
    return identity.id;
  })();

  try {
    return await identifying;
  } finally {
    identifying = null;
  }
}

/**
 * The gate every purchase and restore goes through.
 *
 * Throws rather than falling back to an anonymous id. That is the entire point:
 * a purchase attributed to `$RCAnonymousID:…` produces an `ignored_unknown_user`
 * webhook, which means a real charge and no access, and which nothing in the
 * app can detect afterwards. Refusing costs the user one retry.
 */
async function requirePurchaserId(): Promise<string> {
  if (!purchasesAvailable()) throw new PurchasesUnavailableError();
  return identifyPurchaser();
}

/** This build has no RevenueCat key. Not an error the user caused. */
export class PurchasesUnavailableError extends Error {
  constructor() {
    super("Purchasing is not configured in this build");
  }
}

/** We could not confirm which account is buying. Never buy anyway. */
export class PurchaserUnknownError extends Error {
  constructor() {
    super("Could not confirm which account this purchase belongs to");
  }
}

/**
 * One purchasable plan, as the STORE describes it.
 *
 * `priceLabel` is `product.priceString` — Apple's own localized string for the
 * user's storefront, including the currency sign. It is not derived from
 * `priceUsd` and must not be: `constants.ts` documents its `priceLabel` as the
 * fallback for an unreachable store, and "$2" shown to somebody charged €2,49
 * is a Guideline 3.1.2 disclosure problem, not a cosmetic one.
 */
export interface StorePlan {
  /** The App Store product id — matches `PRODUCTS` in constants.ts. */
  productId: string;
  /** Apple's localized price string, e.g. "$2.00", "€2,49", "£1.79". */
  priceLabel: string;
}

/** Packages held by product id so `purchase()` can find the one to buy. */
let packagesByProductId = new Map<string, PurchasesPackage>();

/**
 * Fetch the current offering.
 *
 * Returns an EMPTY array rather than throwing when the store has nothing, and
 * the caller renders the server's fallback prices without a buy button. Empty
 * is the normal, expected, undiagnosable answer before the Paid Applications
 * Agreement is Active — there is no error and nothing in any log — which is why
 * docs/design/iap-setup.md puts that step first and why the sheet says what it
 * says.
 */
export async function getStorePlans(): Promise<StorePlan[]> {
  if (!purchasesAvailable()) return [];
  const offerings = await Purchases.getOfferings();
  const packages = offerings.current?.availablePackages ?? [];
  packagesByProductId = new Map(packages.map((p) => [p.product.identifier, p]));
  return packages.map((p) => ({
    productId: p.product.identifier,
    priceLabel: p.product.priceString,
  }));
}

/**
 * Buy one plan. Never grants anything — see the header.
 *
 * `getStorePlans()` must have run first; the package objects it cached are what
 * `purchasePackage` needs, and there is no way to reconstruct one from a
 * product id. The sheet always fetches before it can render a price to tap, so
 * the "no such package" branch is only reachable if the offering changed
 * underneath the open sheet.
 */
export async function purchase(productId: string): Promise<PurchaseOutcome> {
  try {
    await requirePurchaserId();
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof PurchasesUnavailableError ? "misconfigured" : "unknown",
    };
  }

  const pkg = packagesByProductId.get(productId);
  if (!pkg) return { kind: "failed", reason: "unavailable" };

  try {
    await Purchases.purchasePackage(pkg);
    return { kind: "purchased", productId };
  } catch (err) {
    return classifyPurchaseError(err);
  }
}

/**
 * Restore. Required by Guideline 3.1.1 for auto-renewable subscriptions, and
 * the only recovery when the entitlement poll gives up.
 *
 * It reports what the STORE has, not what our server has — the caller still
 * confirms with `/api/me/entitlement` afterwards, because a restore that
 * re-attaches a subscription in RevenueCat produces a webhook, and the webhook
 * is what we believe.
 */
export async function restore(): Promise<RestoreOutcome> {
  try {
    await requirePurchaserId();
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof PurchasesUnavailableError ? "misconfigured" : "unknown",
    };
  }

  try {
    const info = await Purchases.restorePurchases();
    const active = info.entitlements.active[REVENUECAT_ENTITLEMENT_ID];
    return active ? { kind: "restored" } : { kind: "nothing_to_restore" };
  } catch (err) {
    const outcome = classifyPurchaseError(err);
    // A restore cannot be cancelled, deferred or already-owned; anything that
    // is not a plain failure would be a lie about what happened.
    return outcome.kind === "failed"
      ? outcome
      : { kind: "failed", reason: "unknown" };
  }
}

/**
 * RevenueCat's error codes → our vocabulary.
 *
 * This mapping lives HERE, beside the import of `PURCHASES_ERROR_CODE`, and not
 * in the shared `purchaseOutcome.ts`, so that `tsc --noEmit` in `mobile/` (the
 * Mobile typecheck CI job) fails if RevenueCat renames a member. A copy of
 * these names in `src/lib/` would be a copy nothing checks — and the values are
 * strings ("1", "20", …), so a stale copy would still compile and silently
 * classify every failure as `unknown`.
 *
 * The two that matter most and are easiest to get wrong:
 *
 *  - PURCHASE_CANCELLED_ERROR is the user closing Apple's sheet. It is not a
 *    failure and must never produce a red message.
 *  - PAYMENT_PENDING_ERROR is Ask to Buy (or any deferred payment). RevenueCat
 *    calls it an *error*; it is a working state with no entitlement, awaiting a
 *    parent's approval, and telling that user something broke is wrong twice —
 *    nothing broke, and nothing was charged.
 */
function classifyPurchaseError(err: unknown): PurchaseOutcome {
  const e = err as { code?: string; userCancelled?: boolean | null } | null;

  // `userCancelled` is deprecated in favour of the code, but it is still
  // populated and it costs nothing to honour both.
  if (e?.userCancelled === true) return { kind: "cancelled" };

  switch (e?.code) {
    case PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR:
      return { kind: "cancelled" };
    case PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR:
      return { kind: "pending" };
    case PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR:
    case PURCHASES_ERROR_CODE.RECEIPT_ALREADY_IN_USE_ERROR:
      return { kind: "already_owned" };

    case PURCHASES_ERROR_CODE.NETWORK_ERROR:
    case PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR:
    case PURCHASES_ERROR_CODE.API_ENDPOINT_BLOCKED:
      return { kind: "failed", reason: "network" };

    case PURCHASES_ERROR_CODE.STORE_PROBLEM_ERROR:
    case PURCHASES_ERROR_CODE.UNEXPECTED_BACKEND_RESPONSE_ERROR:
    case PURCHASES_ERROR_CODE.UNKNOWN_BACKEND_ERROR:
    case PURCHASES_ERROR_CODE.PRODUCT_REQUEST_TIMED_OUT_ERROR:
      return { kind: "failed", reason: "store" };

    // Screen Time, MDM, or a managed device. Nothing the user can do inside
    // this app, and nothing wrong with their account.
    case PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR:
      return { kind: "failed", reason: "not_allowed" };

    case PURCHASES_ERROR_CODE.PURCHASE_INVALID_ERROR:
      return { kind: "failed", reason: "payment_invalid" };

    // The store has no such product to sell. Almost always OUR paperwork: the
    // agreement, Missing Metadata, or a product id that does not match
    // `PRODUCTS` in constants.ts character for character.
    case PURCHASES_ERROR_CODE.PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR:
    case PURCHASES_ERROR_CODE.INELIGIBLE_ERROR:
      return { kind: "failed", reason: "unavailable" };

    case PURCHASES_ERROR_CODE.CONFIGURATION_ERROR:
    case PURCHASES_ERROR_CODE.INVALID_CREDENTIALS_ERROR:
    case PURCHASES_ERROR_CODE.INVALID_APPLE_SUBSCRIPTION_KEY_ERROR:
    case PURCHASES_ERROR_CODE.INVALID_APP_USER_ID_ERROR:
      return { kind: "failed", reason: "misconfigured" };

    default:
      return { kind: "failed", reason: "unknown" };
  }
}

/** Re-exported so screens never import the shared module and this one both. */
export type { PurchaseFailureReason, PurchaseOutcome, RestoreOutcome };
