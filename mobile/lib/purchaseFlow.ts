import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { fetchEntitlement, testPurchase, type EntitlementPayload } from "@/lib/entitlement";
import {
  getStorePlans,
  purchase,
  purchasesAvailable,
  restore,
  type StorePlan,
} from "@/lib/purchases";
import {
  MANAGE_SUBSCRIPTIONS_URL,
  PURCHASE_CONFIRMING_MESSAGE,
  PURCHASE_CONFIRM_TIMEOUT_MESSAGE,
  purchaseOutcomeMessage,
  restoreOutcomeMessage,
} from "@/shared/lib/purchaseOutcome";
import { nextEntitlementPoll } from "@/shared/lib/entitlementPolling";
import {
  manageSubscriptionAvailable,
  resolvePurchaseMode,
  type PurchaseMode,
  type StoreAnswer,
  type UnavailableReason,
} from "@/shared/lib/purchaseMode";
import type { PaywallProduct } from "@/shared/types/entitlement";

/**
 * The purchase flow, in one place, for all three surfaces that sell.
 *
 * Penny's chat bubble (`ChatPanel`), the overlay on the trips list and the trip
 * workspace (`PlanRequiredOverlay`), and the no-trips paywall screen
 * (`app/paywall.tsx`) each used to hold their own copy of "call the purchase
 * endpoint, re-fetch entitlement, believe the second answer". Three copies of a
 * flow whose hard part is what happens when the second answer says NO is three
 * chances to get that wrong, so it is one hook now and they render it.
 *
 * ── The rule this hook exists to enforce ──────────────────────────────────
 *
 * A SUCCESSFUL PURCHASE IS NOT ACCESS. `Purchases.purchasePackage` resolving
 * means Apple charged the card. Our server learns about it separately, when
 * RevenueCat POSTs `/api/webhooks/revenuecat` — the only thing in the system
 * allowed to write an entitlement, and deliberately unable to tell a real
 * purchase from a fake one. So the app does not unlock on the store's word: it
 * polls `GET /api/me/entitlement` until the server agrees, showing the user
 * that it is waiting, and stops after a bounded budget with copy that says the
 * purchase is safe (`entitlementPolling.ts` owns both numbers).
 *
 * The failure this prevents is specific and awful: a user who has paid, sitting
 * in front of a paywall, with a working "buy" button in front of them.
 */

export type PurchasePhase =
  | { kind: "idle" }
  /** Apple's sheet is up. Ours must not be dismissible underneath it. */
  | { kind: "purchasing"; productId: string }
  /** Charged. Waiting for the webhook to reach our server. */
  | { kind: "confirming" }
  | { kind: "restoring" };

/**
 * How this build can take money, decided once — by `resolvePurchaseMode` in
 * the shared module, where it is unit-tested — and rendered rather than
 * guessed at three times.
 *
 *  `test`         the account is on the hardcoded allowlist AND
 *                 `SUBSCRIPTION_TESTING=1` — the server said so, and the route
 *                 re-checks. This wins over `store` on purpose: an allowlisted
 *                 address exists precisely to walk the paywall without Apple,
 *                 and the flag is the switch to turn off when that stops being
 *                 what you want. To exercise the real store, use any other
 *                 address.
 *  `store`        RevenueCat is configured and returned at least one package
 *                 whose product id the server sells.
 *  `unavailable`  neither, and `unavailableReason` says WHICH way. The sheet
 *                 shows prices and says there is nothing to tap, because a
 *                 button that cannot take money is worse than no button — and
 *                 it says why, because "no key in this build", "the agreement
 *                 is not signed" and "the ids do not match" are fixed in three
 *                 different places.
 */
export type { PurchaseMode, UnavailableReason };

export interface PurchaseFlow {
  /** What to render, in the server's order, with the store's prices. */
  plans: PaywallProduct[];
  plansLoading: boolean;
  mode: PurchaseMode;
  /** Why `mode` is `unavailable`; null in every other mode and while loading. */
  unavailableReason: UnavailableReason | null;
  /**
   * Whether Apple's subscriptions screen has anything to show this account.
   * False for a trial (no row has ever existed) and for a promo/admin row
   * (nothing at Apple to manage). Flips to true on the fresh payload the
   * caller stores from `onEntitled`, so it appears in the same session as the
   * purchase that created the row.
   */
  manageSubscriptionAvailable: boolean;
  phase: PurchasePhase;
  /** True while anything is in flight; the sheet must not be dismissed. */
  busy: boolean;
  /** Something went wrong. Red. */
  error: string | null;
  /** Something happened that is not wrong. Not red. */
  notice: string | null;
  buy: (productId: string) => void;
  restorePurchases: () => void;
  manageSubscription: () => void;
  clearMessages: () => void;
}

export function usePurchaseFlow({
  entitlement,
  onEntitled,
}: {
  /** The server's verdict, which carries the plans, their copy and the flag. */
  entitlement: EntitlementPayload | null;
  /**
   * Fired ONCE, with a fresh payload the server has confirmed is entitled.
   * Never fired on a 200 from a purchase or redeem call — that is the whole
   * point of the hook.
   */
  onEntitled: (fresh: EntitlementPayload) => void;
}): PurchaseFlow {
  /**
   * What the store has said so far. Starts as `no_key` when this build carries
   * no RevenueCat key — that is known synchronously and there is nothing to
   * wait for — and as `pending` otherwise, until the effect below hears back.
   */
  const [storeAnswer, setStoreAnswer] = useState<StoreAnswer>(
    purchasesAvailable() ? { kind: "pending" } : { kind: "no_key" }
  );
  const [phase, setPhase] = useState<PurchasePhase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Unmount guard. The poll below can run for a minute, and the user is free to
   * navigate away from the trip they bought from — a `setState` after that is a
   * warning at best and a resurrected sheet at worst.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const testMode = entitlement?.testPurchaseAllowed === true;

  /**
   * Ask the store for prices, once, as soon as there is something to sell.
   *
   * Skipped entirely in test mode — that account is not buying from Apple, and
   * an offerings call whose empty answer we would ignore is a round trip for
   * nothing.
   */
  useEffect(() => {
    if (testMode || !purchasesAvailable()) return;
    let cancelled = false;
    void (async () => {
      try {
        const plans: StorePlan[] = await getStorePlans();
        if (!cancelled) setStoreAnswer({ kind: "packages", plans });
      } catch {
        // An unreachable store is not a red error to put in front of the user:
        // the sheet falls back to the server's prices and says the store could
        // not be reached. Recorded as its own answer rather than as an empty
        // offering, because "RevenueCat said nothing is for sale" (the
        // agreement, docs/design/iap-setup.md §1) and "we never heard from
        // RevenueCat" (network, a rejected key) are different problems that
        // used to render the same sentence.
        if (!cancelled) setStoreAnswer({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testMode]);

  /**
   * The server decides WHAT is for sale and how it reads; the store decides
   * what it COSTS; and `resolvePurchaseMode` (shared, unit-tested) decides
   * which of the three modes that adds up to and — when it is `unavailable` —
   * why. The merge rules, the one-plan-surviving asymmetry and the fallback to
   * the server's prices all live there, with the tests.
   */
  const serverPlans: PaywallProduct[] = entitlement?.products ?? [];
  const { mode, unavailableReason, plans, plansLoading } = resolvePurchaseMode({
    testMode,
    storeAnswer,
    serverPlans,
  });

  /**
   * Poll until the server agrees, or until the budget runs out.
   *
   * Returns true if it flipped. The give-up path is NOT an error — the money is
   * real, the webhook retries on its own for hours, and the next app open
   * resolves it — so it sets a notice rather than an error, with copy that
   * leads on the charge having gone through.
   */
  const waitForEntitlement = useCallback(async (): Promise<boolean> => {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      const decision = nextEntitlementPoll(attempt, Date.now() - startedAt);
      if (decision.giveUp) return false;
      await new Promise((r) => setTimeout(r, decision.waitMs));
      if (!alive.current) return false;
      const fresh = await fetchEntitlement();
      if (fresh?.entitled) {
        if (alive.current) onEntitled(fresh);
        return true;
      }
    }
  }, [onEntitled]);

  const buy = useCallback(
    (productId: string) => {
      if (phase.kind !== "idle") return;
      setError(null);
      setNotice(null);
      setPhase({ kind: "purchasing", productId });

      void (async () => {
        try {
          if (mode === "test") {
            // The allowlisted path. It writes a real `subscriptions` row through
            // the same `upsertSubscription` the webhook uses, so the wait below
            // is a formality — but it goes through the same wait anyway, because
            // one code path that has been walked is worth more than two that
            // have not.
            await testPurchase(productId);
          } else {
            const outcome = await purchase(productId);
            if (outcome.kind !== "purchased") {
              const message = purchaseOutcomeMessage(outcome);
              // `pending` (Ask to Buy) and `already_owned` are not failures.
              // Ask to Buy in particular arrives as an SDK *error* code for a
              // state that is working exactly as designed.
              if (outcome.kind === "pending" || outcome.kind === "already_owned") {
                setNotice(message);
              } else if (message) {
                setError(message);
              }
              return;
            }
          }

          if (!alive.current) return;
          setPhase({ kind: "confirming" });
          const ok = await waitForEntitlement();
          if (!alive.current) return;
          if (!ok) setNotice(PURCHASE_CONFIRM_TIMEOUT_MESSAGE);
        } catch (err) {
          // Only the test path throws — `purchase()` returns outcomes. This is
          // the 403 for an address that is not on the allowlist, or a network
          // failure reaching our own API.
          if (alive.current) {
            setError(err instanceof Error ? err.message : "That purchase did not go through.");
          }
        } finally {
          if (alive.current) setPhase({ kind: "idle" });
        }
      })();
    },
    [mode, phase.kind, waitForEntitlement]
  );

  const restorePurchases = useCallback(() => {
    if (phase.kind !== "idle") return;
    setError(null);
    setNotice(null);
    setPhase({ kind: "restoring" });

    void (async () => {
      try {
        const outcome = await restore();
        if (!alive.current) return;
        if (outcome.kind !== "restored") {
          const message = restoreOutcomeMessage(outcome);
          // "Nothing on this Apple ID" is information, not a failure — the
          // likeliest cause is a second Apple ID, which the user cannot guess.
          if (outcome.kind === "nothing_to_restore") setNotice(message);
          else if (message) setError(message);
          return;
        }

        setPhase({ kind: "confirming" });
        // A restore usually finds a subscription our server already knows about,
        // so the first poll answers. It still goes through the wait because a
        // restore can also be the first time RevenueCat associates the purchase
        // with this account, and that arrives as a webhook like anything else.
        const ok = await waitForEntitlement();
        if (!alive.current) return;
        if (!ok) {
          setNotice(
            "Apple gave your plan back, but it hasn't switched on here yet. Reopen the app in " +
              "a moment — nothing has been charged."
          );
        }
      } finally {
        if (alive.current) setPhase({ kind: "idle" });
      }
    })();
  }, [phase.kind, waitForEntitlement]);

  const manageSubscription = useCallback(() => {
    // Apple's own screen. Nothing to catch: a failure to open it leaves the
    // sheet exactly as it was, and there is no second way to get there.
    void Linking.openURL(MANAGE_SUBSCRIPTIONS_URL).catch(() => {});
  }, []);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return {
    plans,
    plansLoading,
    mode,
    unavailableReason,
    manageSubscriptionAvailable: manageSubscriptionAvailable(entitlement),
    phase,
    busy: phase.kind !== "idle",
    error,
    // While the wait is on, the waiting copy IS the notice. It has to say the
    // money part first: this reader has just watched Apple confirm a charge,
    // and anything reading like "processing…" invites a second attempt.
    notice: phase.kind === "confirming" ? PURCHASE_CONFIRMING_MESSAGE : notice,
    buy,
    restorePurchases,
    manageSubscription,
    clearMessages,
  };
}
