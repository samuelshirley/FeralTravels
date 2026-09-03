import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TypingBubble } from "@/components/chat/Indicators";
import PurchaseSheet from "@/components/PurchaseSheet";
import { fetchEntitlement, type EntitlementPayload } from "@/lib/entitlement";
import { usePurchaseFlow } from "@/lib/purchaseFlow";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

const SUPPORT_EMAIL = "support@feraltravels.com";

/**
 * Penny's chat, for a user who has no trip to have it in.
 *
 * The problem this solves is structural. Chat is trip-scoped everywhere else —
 * `chat_history.trip_id` is `NOT NULL`, and `ChatPanel` cannot render without a
 * `tripId`. So the one account that most needs to be told about the paywall,
 * somebody whose trial lapsed before they ever made a trip, is the one account
 * with nowhere to be told. The alternative was a modal on the trips list, which
 * is exactly the thing this design refuses: the user is not handed a sheet, she
 * tells them.
 *
 * So this screen is a chat that holds one message. Same header, same bubble,
 * same typing indicator, no composer — because there is nothing to say back
 * yet. It is deliberately NOT a `ChatPanel` with a null trip: threading
 * "sometimes there is no trip" through 1700 lines of a component whose every
 * path assumes one would be a much larger change than a screen that borrows
 * three of its styles.
 *
 * Users who DO have trips never come here. They keep the trips list, their
 * itineraries stay readable, and the same paywall message meets them inside any
 * trip's chat — see the `paywall` flag in ChatPanel.
 */
export default function PaywallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [loading, setLoading] = useState(true);

  // Penny types before she speaks, the way she does on a first trip. The delay
  // is the same 3s the onboarding greeting uses (ChatPanel's `isFirstQuestion`
  // branch) — this is her first message to this user in the same sense.
  const [typing, setTyping] = useState(true);

  const [sheetOpen, setSheetOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The purchase, the wait for the webhook and the restore all live in the
   * hook — this screen only says where to go once the server agrees. Same
   * destination as a redeemed promo code: this screen exists only to sell, so
   * the moment there is nothing left to sell, leave.
   */
  const flow = usePurchaseFlow({
    entitlement,
    onEntitled: () => {
      setSheetOpen(false);
      router.replace("/trips");
    },
  });

  const load = useCallback(async () => {
    const payload = await fetchEntitlement();
    setEntitlement(payload);
    setLoading(false);

    // Entitled again — a purchase landed, or the webhook caught up while the
    // app was closed. Nothing to sell; get out of the way.
    if (payload?.entitled) {
      router.replace("/trips");
      return;
    }
    timer.current = setTimeout(() => setTyping(false), 3000);
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }, [load])
  );

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const paywall = entitlement?.paywall ?? null;
  const reason = entitlement?.blockReason ?? null;
  // Nothing to sell a capped or revoked account — the answer is a human, not a
  // price list. Same branch as the in-chat button.
  const sellable = reason !== "usage_cap" && reason !== "revoked";

  function onButtonPress() {
    if (sellable) {
      flow.clearMessages();
      setSheetOpen(true);
      return;
    }
    void Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>P</Text>
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerName}>Penny</Text>
          <Text style={styles.headerSub}>YOUR TRIP PLANNER</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.spacer} />
        {loading || typing ? (
          <TypingBubble />
        ) : (
          <View style={styles.bubble}>
            {(paywall?.message ?? fallbackMessage()).split(/\n{2,}/).map((para, i) => (
              <Text key={i} style={[styles.bubbleText, i > 0 ? styles.paraGap : null]}>
                {para}
              </Text>
            ))}

            <Pressable accessibilityRole="button" onPress={onButtonPress} style={styles.cta}>
              <Text style={styles.ctaText}>
                {paywall?.buttonLabel ?? (sellable ? "Keep planning" : "Email support")}
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {sheetOpen && entitlement ? (
        <PurchaseSheet
          flow={flow}
          onRedeemed={() => {
            setSheetOpen(false);
            router.replace("/trips");
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * Only reachable when the entitlement fetch failed outright, which is why it
 * says nothing specific about trials or prices — we do not know which of them
 * applies. A blank screen would be worse.
 */
function fallbackMessage(): string {
  return "I can't plan on this account right now. Pull to reload, or get in touch and we'll sort it out.";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.surfaceMuted },

  // Deliberately identical to ChatPanel's header — this has to read as the
  // same conversation, not as a billing screen wearing her name.
  header: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: theme.onPrimary, fontFamily: font.extrabold, fontSize: 13 },
  headerCopy: { minWidth: 0 },
  headerName: { fontSize: 14, fontFamily: font.bold, color: theme.text },
  headerSub: {
    fontFamily: font.regular,
    fontSize: 10,
    color: theme.subtle,
    letterSpacing: 0.4,
    marginTop: 2,
  },

  scrollContent: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },
  // Bottom-pins a short conversation, same trick as the transcript.
  spacer: { flex: 1 },

  bubble: {
    alignSelf: "flex-start",
    maxWidth: "88%",
    backgroundColor: theme.surface,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  bubbleText: { fontFamily: font.regular, fontSize: 14, color: theme.text, lineHeight: 21 },
  paraGap: { marginTop: 12 },

  cta: {
    marginTop: 14,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: theme.primary,
    alignItems: "center",
  },
  ctaText: { fontFamily: font.bold, fontSize: 14, color: theme.onPrimary },
});
