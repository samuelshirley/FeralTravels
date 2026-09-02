import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "@/components/ui";
import PurchaseSheet from "@/components/PurchaseSheet";
import { fetchEntitlement, type EntitlementPayload } from "@/lib/entitlement";
import { usePurchaseFlow } from "@/lib/purchaseFlow";
import { planStatusLine } from "@/shared/lib/planStatusLine";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The plan, on Settings: what you are on, how to buy, restore, and manage.
 *
 * This is the ONLY surface in the app that opens the purchase sheet in every
 * account state. The other three — Penny's bubble, `PlanRequiredOverlay`,
 * `app/paywall.tsx` — are paywalls, and every one of them is gated on the
 * account NOT being entitled. That gating had a consequence nobody had walked:
 *
 *   An App Review reviewer signs in with their own Apple ID, exactly as
 *   `docs/design/app-store-listing.md` tells them to and exactly as guideline
 *   2.1(a) wants. They land in a fresh seven-day trial. Entitled. So no
 *   paywall renders, no sheet can be opened, and there is no screen in the
 *   whole app that shows a price — never mind one that completes a sandbox
 *   purchase. That is the "we were unable to locate the in-app purchases"
 *   rejection, and no review note can write around a screen that does not
 *   exist.
 *
 * So "View plans" is here, unconditional. It is also the honest product
 * behaviour: somebody three days into a trial who has decided should be able to
 * subscribe without waiting to be blocked, and a monthly subscriber should be
 * able to find the annual price. `GET /api/me/entitlement` sends `products` in
 * every state for the same reason.
 *
 * Restore and Manage were already here, and they stay for the people they were
 * put here for — someone who has ALREADY paid, who therefore never sees a
 * paywall and never opens a sheet from one:
 *
 *  - A reinstall, or a new phone. The subscription is on their Apple ID and our
 *    server knows nothing about this install. They are entitled the moment
 *    Restore runs, and until they find it the app looks like it forgot them.
 *  - Anyone whose entitlement wait gave up. The timeout copy tells them to try
 *    Restore; this is where they will look for it.
 *  - Cancelling. Guideline 3.1.2 wants the management screen reachable, and a
 *    subscriber looking for "how do I stop paying" goes to Settings, not to a
 *    sheet that is trying to sell them something.
 *
 * `PlanRequiredOverlay` is deliberately never mounted on this screen (account
 * deletion and sign-out live here and neither may sit behind a paywall), so all
 * of this is reachable in every account state — which is exactly what a blocked
 * user needs when the thing that unblocks them is a restore.
 *
 * ── Showing Restore only to accounts we think have bought: considered, rejected
 *
 * The idea is to hide Restore unless our records show a prior subscription for
 * this email. Two reasons it does not work, both fatal:
 *
 *  1. **We cannot know.** The purchase lives on the APPLE ID, not on our
 *     account. New phone, reinstall, or a different email on our side with the
 *     same Apple ID — those are precisely the cases Restore exists for, and in
 *     every one of them our records say nothing. Gating on them makes the
 *     control invisible to exactly the person who needs it. The only way to
 *     find out whether an Apple ID has a prior purchase is to run a restore.
 *  2. **Guideline 3.1.1** expects a restore mechanism to be available for
 *     auto-renewable purchases. Hiding it behind a condition we cannot evaluate
 *     is a review risk for no user benefit.
 *
 * What IS fair, and what this file does: demote it. "View plans" is the primary
 * button; Restore and Manage are quiet text links beneath. Do not delete this
 * block — it is load-bearing for the next person who has the same instinct.
 */
export default function SubscriptionSection() {
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchEntitlement().then((payload) => {
      if (!cancelled) setEntitlement(payload);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const flow = usePurchaseFlow({
    entitlement,
    onEntitled: (fresh) => {
      // Close on the SERVER's word, the same as every other surface. For an
      // account that was already entitled when the sheet opened — a trial user
      // buying early, a reviewer in sandbox — the first poll answers yes
      // immediately, so this fires as soon as the charge clears. That is
      // correct: there is nothing left to wait for.
      setSheetOpen(false);
      setEntitlement(fresh);
    },
  });

  const status = entitlement
    ? planStatusLine(
        {
          state: entitlement.state,
          trialDaysRemaining: entitlement.trialDaysRemaining,
          trialEndsAt: entitlement.trialEndsAt,
          plan: entitlement.plan,
          currentPeriodEnd: entitlement.currentPeriodEnd,
          autoRenew: entitlement.autoRenew,
        },
        // The one thing the clock decides is whether a date carries its year.
        // Passed in rather than read inside, so the boundary is testable.
        new Date()
      )
    : null;

  return (
    <>
      <Card style={styles.section}>
        <Text style={styles.sectionTitle}>Plan</Text>

        {/*
          Null while the first fetch is in flight, and null again if it failed.
          A failed entitlement fetch must not blank this card: Restore is the
          one control a user with a dead-looking account is here for, and it
          does not need the payload to work.
        */}
        {status ? <Text style={styles.status}>{status}</Text> : null}

        <View style={styles.row}>
          {/*
            First and primary. It is the control a reviewer is sent to find, and
            the one a trial user is looking for.
          */}
          <Pressable
            testID="settings-view-plans"
            accessibilityRole="button"
            onPress={() => {
              flow.clearMessages();
              setSheetOpen(true);
            }}
            disabled={flow.busy}
            style={[styles.primaryButton, flow.busy ? styles.buttonOff : null]}
          >
            <Text style={styles.primaryButtonText}>View plans</Text>
          </Pressable>
        </View>

        {/*
          Secondary, and visually quieter than "View plans" — but always
          present. See the note at the top of this file for why neither is
          conditional.
        */}
        <View style={styles.row}>
          <Pressable
            testID="settings-restore-purchases"
            accessibilityRole="button"
            onPress={flow.restorePurchases}
            disabled={flow.busy}
            style={[styles.button, flow.busy ? styles.buttonOff : null]}
          >
            {flow.phase.kind === "restoring" || flow.phase.kind === "confirming" ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <Text style={styles.buttonText}>Restore purchases</Text>
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={flow.manageSubscription}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Manage subscription</Text>
          </Pressable>
        </View>

        {/*
          Same two channels as the sheet: a restore that found nothing is not a
          failure, and painting it red would send a paying user to support.

          Only shown while the sheet is CLOSED. The sheet renders the same
          `flow`'s messages itself, and two copies of "Payment received —
          switching your plan on…" on one screen reads as two events.
        */}
        {!sheetOpen && flow.notice ? <Text style={styles.notice}>{flow.notice}</Text> : null}
        {!sheetOpen && flow.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {flow.error}
          </Text>
        ) : null}
      </Card>

      {/*
        No `onRedeemed`, so no promo box. A code is redeemed on the surface that
        blocked you, which is where somebody who was given one has been told to
        look; a redemption field on Settings would be a second place to keep
        right for no one who needs it.
      */}
      {sheetOpen ? (
        <PurchaseSheet flow={flow} onClose={() => setSheetOpen(false)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: { padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontFamily: font.bold, color: theme.text, marginBottom: 6 },
  status: { fontFamily: font.semibold, fontSize: 14, color: theme.text, marginBottom: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", columnGap: 18, rowGap: 4, alignItems: "center" },
  primaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primary,
    minHeight: 40,
    justifyContent: "center",
    marginBottom: 6,
  },
  primaryButtonText: { fontFamily: font.semibold, fontSize: 14, color: theme.onPrimary },
  button: { paddingVertical: 8, minHeight: 34, justifyContent: "center" },
  buttonOff: { opacity: 0.45 },
  // 13, not 14: Restore and Manage are the quiet pair under "View plans".
  // Demoting them is fair; hiding them is not.
  buttonText: { fontFamily: font.medium, fontSize: 13, color: theme.primary },
  notice: {
    marginTop: 10,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    color: theme.muted,
  },
  error: {
    marginTop: 10,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    color: theme.danger,
  },
});
