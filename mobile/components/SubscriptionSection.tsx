import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Card } from "@/components/ui";
import { fetchEntitlement, type EntitlementPayload } from "@/lib/entitlement";
import { usePurchaseFlow } from "@/lib/purchaseFlow";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Restore purchases and Manage subscription, on Settings.
 *
 * These are on the purchase sheet too, and that is not duplication — the two
 * are for different people. The sheet's copies are for somebody being sold to.
 * These are for somebody who has ALREADY paid, and who therefore never sees a
 * paywall and never opens that sheet:
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
 * deletion and sign-out live here and neither may sit behind a paywall), so
 * this section is reachable in every account state — which is exactly what a
 * blocked user needs when the thing that unblocks them is a restore.
 */
export default function SubscriptionSection() {
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchEntitlement().then((payload) => {
      if (!cancelled) setEntitlement(payload);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const flow = usePurchaseFlow({ entitlement, onEntitled: setEntitlement });

  return (
    <Card style={styles.section}>
      <Text style={styles.sectionTitle}>Plan</Text>
      <Text style={styles.blurb}>
        If you bought a plan on this Apple ID — on another device, or before reinstalling —
        Restore puts it back on this account. You will not be charged again.
      </Text>

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

      {/* Same two channels as the sheet: a restore that found nothing is not a
          failure, and painting it red would send a paying user to support. */}
      {flow.notice ? <Text style={styles.notice}>{flow.notice}</Text> : null}
      {flow.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {flow.error}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontFamily: font.bold, color: theme.text, marginBottom: 6 },
  blurb: {
    fontFamily: font.regular,
    fontSize: 13,
    color: theme.muted,
    lineHeight: 20,
    marginBottom: 14,
  },
  row: { flexDirection: "row", flexWrap: "wrap", columnGap: 18, rowGap: 4 },
  button: { paddingVertical: 8, minHeight: 34, justifyContent: "center" },
  buttonOff: { opacity: 0.45 },
  buttonText: { fontFamily: font.semibold, fontSize: 14, color: theme.primary },
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
