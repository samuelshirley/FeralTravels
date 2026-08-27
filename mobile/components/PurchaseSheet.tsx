import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";
import type { PaywallProduct } from "@/shared/types/entitlement";

/**
 * Native mirror of src/components/PurchaseSheet.tsx — the purchase sheet, and
 * the ONLY modal in the paywall flow.
 *
 * Penny's paywall lives in the transcript as a message, deliberately: a sheet
 * thrown over the app on launch is the thing we are not doing. But a purchase
 * IS a modal everywhere else on this platform — on iPhone this component is
 * replaced wholesale by Apple's StoreKit sheet, which is modal, dismissible and
 * stops the world. Matching that shape here means the flow we ship today and
 * the flow StoreKit gives us are the same flow, and the day StoreKit lands this
 * component is deleted rather than redesigned.
 *
 * It renders prices it was handed. It does not decide who can buy, what a plan
 * costs, or whether the fake-purchase path is available — all three come from
 * `GET /api/me/entitlement`, and the server refuses the purchase again on its
 * own authority regardless of what this sheet chose to show.
 *
 * Divergences from the web sheet, and why:
 *
 *  1. It rises from the BOTTOM edge rather than sitting centred in a dimmed
 *     page. StoreKit's sheet is a bottom sheet; a centred card would train the
 *     user on a shape that changes under them the week Apple takes over.
 *  2. No gradient hairline. The web paints a primary→accent linear-gradient
 *     across the top of the card; RN has no gradient without another native
 *     dependency (same call already made for the chat header avatar), so it is
 *     a flat primary rule.
 *  3. `testPurchaseAllowed === false` says purchasing is not wired up yet,
 *     where the web sends the reader to the App Store. There is nowhere to send
 *     them from here — this IS the iPhone app — so the honest answer is that
 *     the button does not exist yet.
 */
export default function PurchaseSheet({
  products,
  testPurchaseAllowed,
  purchasingId,
  error,
  onPurchase,
  onClose,
}: {
  products: PaywallProduct[];
  /**
   * The server's answer, never the client's guess. False means this build
   * cannot complete a purchase at all — the sheet then shows the prices and
   * says so, because a button that cannot take money is worse than no button.
   */
  testPurchaseAllowed: boolean;
  /** Product id currently in flight, or null. */
  purchasingId: string | null;
  error: string | null;
  onPurchase: (productId: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const busy = purchasingId !== null;

  // Backdrop taps and the Android back button both dismiss — except while a
  // grant is in flight, where dismissing would leave the account paid up and
  // the UI still paywalled until the next launch.
  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={dismiss}>
      <Pressable style={styles.backdrop} onPress={dismiss}>
        {/* Swallow taps inside the sheet so reading a price doesn't dismiss
            the thing the user is trying to read. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}
          onPress={() => {}}
        >
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Feral Travels</Text>
              <Text style={styles.subtitle}>Choose a plan</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={dismiss}
              disabled={busy}
              hitSlop={10}
            >
              <Text style={[styles.closeX, busy ? styles.closeXOff : null]}>×</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.plans}>
              {products.map((p) => (
                <PlanRow
                  key={p.id}
                  product={p}
                  // Only an allowlisted account gets a pressable row.
                  actionable={testPurchaseAllowed}
                  busy={busy}
                  pending={purchasingId === p.id}
                  onSelect={() => onPurchase(p.id)}
                />
              ))}
            </View>

            {testPurchaseAllowed ? (
              <View style={styles.testNotice}>
                {/* Loud on purpose. This path grants real paid access with
                    no payment, and the one place that must be unmistakable is a
                    screenshot of the sheet that granted it. */}
                <Text style={styles.testNoticeText}>
                  <Text style={styles.testNoticeStrong}>Test purchase — no payment.</Text> Your
                  account is allowlisted, so picking a plan grants it directly and logs a
                  FAKE_PURCHASE event. No money moves.
                </Text>
              </View>
            ) : (
              <Text style={styles.notWiredText}>
                Purchasing isn&apos;t wired up yet — these are the prices, not a checkout. Apple
                returns an empty product list until the Paid Applications Agreement is active, so
                there is nothing here to tap.
              </Text>
            )}

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One price. Pressable only where a purchase can actually be completed. */
function PlanRow({
  product,
  actionable,
  busy,
  pending,
  onSelect,
}: {
  product: PaywallProduct;
  actionable: boolean;
  busy: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  const inner = (
    <>
      <View style={styles.planPrice}>
        <Text style={styles.planPriceLabel}>{product.priceLabel}</Text>
        <Text style={styles.planCadence}>{product.cadence}</Text>
      </View>
      <View style={styles.planTrailing}>
        {product.note ? (
          <View style={styles.planNote}>
            <Text style={styles.planNoteText}>{product.note}</Text>
          </View>
        ) : null}
        {pending ? <ActivityIndicator size="small" color={theme.primary} /> : null}
      </View>
    </>
  );

  if (!actionable) {
    // A plain View, not a disabled button: there is nothing wrong with this
    // account, the price simply isn't purchasable yet. A greyed-out button
    // would read as "you can't have this".
    return <View style={styles.planRow}>{inner}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${product.priceLabel} ${product.cadence}`}
      onPress={onSelect}
      disabled={busy}
      style={[styles.planRow, busy && !pending ? styles.planRowDim : null]}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: theme.radiusLg,
    borderTopRightRadius: theme.radiusLg,
    paddingHorizontal: 20,
    paddingTop: 8,
    maxHeight: "85%",
    ...shadow.md,
  },
  /* The pill every iOS bottom sheet wears, StoreKit's included. */
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  headerCopy: { minWidth: 0, flexShrink: 1 },
  title: { fontFamily: font.bold, fontSize: 18, color: theme.text },
  subtitle: { fontFamily: font.regular, fontSize: 13, color: theme.muted, marginTop: 2 },
  closeX: { fontFamily: font.regular, fontSize: 22, lineHeight: 24, color: theme.subtle },
  closeXOff: { opacity: 0.4 },

  scroll: { marginTop: 18 },
  scrollContent: { paddingBottom: 4 },
  plans: { gap: 8 },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  planRowDim: { opacity: 0.5 },
  planPrice: { flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0, flexShrink: 1 },
  planPriceLabel: { fontFamily: font.bold, fontSize: 17, color: theme.text },
  planCadence: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  planTrailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  planNote: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: theme.successMuted,
  },
  planNoteText: { fontFamily: font.semibold, fontSize: 11, color: theme.success },

  testNotice: {
    marginTop: 14,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.warningMuted,
    borderWidth: 1,
    borderColor: "rgba(184, 149, 106, 0.45)",
    borderRadius: theme.radiusSm,
  },
  testNoticeText: { fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: theme.text },
  testNoticeStrong: { fontFamily: font.bold },

  notWiredText: {
    marginTop: 14,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    color: theme.muted,
  },

  errorBox: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.dangerMuted,
    borderWidth: 1,
    borderColor: "rgba(198, 93, 74, 0.35)",
    borderRadius: theme.radiusSm,
  },
  errorText: { fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: theme.danger },
});
