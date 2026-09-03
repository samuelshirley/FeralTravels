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
 * How this build can take money, decided once and rendered rather than guessed
 * at three times.
 *
 *  `test`         the account is on the hardcoded allowlist AND
 *                 `SUBSCRIPTION_TESTING=1` — the server said so, and the route
 *                 re-checks. This wins over `store` on purpose: an allowlisted
 *                 address exists precisely to walk the paywall without Apple,
 *                 and the flag is the switch to turn off when that stops being
 *                 what you want. To exercise the real store, use any other
 *                 address.
 *  `store`        RevenueCat is configured and returned at least one package.
 *  `unavailable`  neither. The sheet shows prices and says there is nothing to
 *                 tap, because a button that cannot take money is worse than no
 *                 button.
 */
export type PurchaseMode = "test" | "store" | "unavailable";

export interface PurchaseFlow {
  /** What to render, in the server's order, with the store's prices. */
  plans: PaywallProduct[];
  plansLoading: boolean;
  mode: PurchaseMode;
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
  const [storePlans, setStorePlans] = useState<StorePlan[] | null>(null);
  const [plansLoading, setPlansLoading] = useState(purchasesAvailable());
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
    if (testMode || !purchasesAvailable()) {
      setPlansLoading(false);
      return;
    }
    let cancelled = false;
    setPlansLoading(true);
    void (async () => {
      try {
        const plans = await getStorePlans();
        if (!cancelled) setStorePlans(plans);
      } catch {
        // An unreachable store is not an error to put in front of the user: the
        // sheet falls back to the server's prices and says it cannot sell them.
        // The diagnosis for an EMPTY offering is in docs/design/iap-setup.md and
        // there is nothing the reader of this screen can do about it.
        if (!cancelled) setStorePlans([]);
      } finally {
        if (!cancelled) setPlansLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testMode]);

  /**
   * The server decides WHAT is for sale and how it reads; the store decides
   * what it COSTS.
   *
   * Merged in the server's order, so the cadence ("per month"), the note
   * ("Save $4 a year") and the ordering stay server-authored and reword-able
   * without a TestFlight build — while `priceLabel` becomes Apple's own
   * localized string. `constants.ts` documents its `priceLabel` as the fallback
   * for an unreachable store, and it is: "$2" in front of somebody charged
   * €2,49 is a Guideline 3.1.2 problem, not a cosmetic one.
   *
   * A server product with no matching store package is DROPPED in store mode.
   * Apple cannot sell it, so offering it would produce a tap that can only
   * fail — and it is the exact symptom of a product id that does not match
   * `PRODUCTS` character for character.
   */
  const serverPlans = entitlement?.products ?? [];
  const merged: PaywallProduct[] = (storePlans ?? []).length
    ? serverPlans.flatMap((p) => {
        const store = storePlans!.find((s) => s.productId === p.id);
        return store ? [{ ...p, priceLabel: store.priceLabel }] : [];
      })
    : [];

  /**
   * NOTHING matching is a different failure from SOME matching, and it falls
   * back rather than showing an empty sheet: the user still reads what a plan
   * costs, roughly, and the copy under it says it cannot be bought here. An
   * empty sheet would say nothing at all.
   *
   * One plan surviving where there should be two, on the other hand, is left
   * exactly as it is — that asymmetry is diagnostic. It is what a single
   * mistyped product id looks like, and papering over it with the fallback
   * price would produce a tap that can only fail.
   */
  const plans: PaywallProduct[] = merged.length > 0 ? merged : serverPlans;

  const mode: PurchaseMode = testMode ? "test" : merged.length > 0 ? "store" : "unavailable";

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
