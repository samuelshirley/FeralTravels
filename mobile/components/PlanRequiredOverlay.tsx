import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import PurchaseSheet from "@/components/PurchaseSheet";
import type { EntitlementPayload } from "@/lib/entitlement";
import { usePurchaseFlow } from "@/lib/purchaseFlow";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

const SUPPORT_EMAIL = "support@feraltravels.com";

/**
 * The hard block, everywhere that isn't Penny.
 *
 * An account past its seven days lands in her chat on open (trips/index.tsx),
 * and that is where the real conversation happens. But the bottom nav is still
 * there, and the trips list is still there, so tapping either has to arrive
 * somewhere that says the same thing. This is that somewhere.
 *
 * It COVERS, it does not replace. The screen underneath stays mounted and stays
 * legible through the scrim on purpose: an itinerary the user can still see is
 * the app saying "this is still yours", which is the difference between a block
 * and a repossession. Someone halfway up a fjord who let a card expire should be
 * able to read the plan they are driving even while they cannot change it.
 *
 * NOTE: this reverses the "Allowed: viewing existing trips" soft block in
 * docs/design/subscriptions.md — reading is now blocked too, at the owner's
 * instruction. The doc has not been edited; one of the two is out of date.
 *
 * Deliberately NOT mounted on /settings, and it carries its own link there.
 * Account deletion lives on that screen and App Store guideline 5.1.1(v)
 * requires it to be reachable from inside the app — a scrim over the one screen
 * that can delete an account, with no way past it, is how a release gets
 * rejected. Sign-out is on the same screen for the same reason.
 */
export default function PlanRequiredOverlay({
  entitlement,
  onBackToPenny,
  onEntitled,
}: {
  /**
   * The server's answer, or null when we could not ask. Null NEVER blocks — a
   * phone drops its network constantly, and paywalling a paying customer in a
   * tunnel is the one failure mode worth being asymmetric about. Every route
   * that spends money gates itself server-side regardless.
   */
  entitlement: EntitlementPayload | null;
  /** Take them to the one screen that is not covered: Penny's chat. */
  onBackToPenny: () => void;
  /** Fired with a fresh, entitled payload once a purchase actually lands. */
  onEntitled: (payload: EntitlementPayload) => void;
}) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Above the early return, and it has to be: this component returns null for
  // an entitled account, and a hook called after that would run on some renders
  // and not others.
  const flow = usePurchaseFlow({
    entitlement,
    onEntitled: (fresh) => {
      setSheetOpen(false);
      onEntitled(fresh);
    },
  });

  if (!entitlement || entitlement.entitled) return null;

  const reason = entitlement.blockReason;
  // Two of the four reasons have nothing to sell: a capped account is our own
  // cost ceiling and a revoked one cannot be bought back. Same branch as the
  // button inside Penny's bubble.
  const sellable = reason !== "usage_cap" && reason !== "revoked";
  const paragraphs = (entitlement.paywall?.message ?? FALLBACK).split(/\n{2,}/);
  const buttonLabel =
    entitlement.paywall?.buttonLabel ?? (sellable ? "Keep planning" : "Email support");

  return (
    <View style={styles.root}>
      {/* Swallows every tap that isn't on the card. The screen behind is
          readable, not operable — that is the whole shape of this block. */}
      <Pressable
        accessibilityRole="none"
        accessibilityLabel="Planning is paused on this account"
        style={styles.scrim}
        onPress={() => {}}
      />

      <View style={styles.card}>
        <Text style={styles.heading}>Planning is paused</Text>

        {paragraphs.map((para, i) => (
          <Text key={i} style={[styles.body, i > 0 ? styles.paraGap : null]}>
            {para}
          </Text>
        ))}

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (sellable) {
              flow.clearMessages();
              setSheetOpen(true);
              return;
            }
            void Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
          }}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>{buttonLabel}</Text>
        </Pressable>

        <View style={styles.secondaryRow}>
          <Pressable accessibilityRole="button" onPress={onBackToPenny} style={styles.secondary}>
            <Text style={styles.secondaryText}>Back to Penny</Text>
          </Pressable>
          {/* The way out that is not a purchase. Settings holds sign-out and
              account deletion, and neither may ever sit behind a paywall. */}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/settings")}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Account settings</Text>
          </Pressable>
        </View>
      </View>

      {sheetOpen ? <PurchaseSheet flow={flow} onClose={() => setSheetOpen(false)} /> : null}
    </View>
  );
}

/**
 * Only reachable when the entitlement call answered "not entitled" but carried
 * no copy — a shape the server does not currently produce. It says nothing
 * about trials or prices because in that case we do not know which applies.
 */
const FALLBACK = "I can't plan on this account right now. Open the chat and I'll explain.";

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", padding: 20 },
  // --tp-overlay. Dark enough to read the card against, light enough that the
  // trips or the itinerary underneath are still legible.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusMd,
    paddingVertical: 20,
    paddingHorizontal: 20,
    ...shadow.md,
  },
  heading: { fontFamily: font.bold, fontSize: 17, color: theme.text, marginBottom: 10 },
  body: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: theme.muted },
  paraGap: { marginTop: 10 },
  cta: {
    marginTop: 16,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: theme.primary,
    alignItems: "center",
  },
  ctaText: { fontFamily: font.bold, fontSize: 14, color: theme.onPrimary },
  secondaryRow: {
    marginTop: 4,
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    columnGap: 18,
  },
  secondary: { paddingVertical: 8, alignItems: "center" },
  secondaryText: { fontFamily: font.medium, fontSize: 13, color: theme.primary },
});
