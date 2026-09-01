import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_BASE_URL } from "@/lib/config";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";
import type { PaywallProduct } from "@/shared/types/entitlement";
import {
  PROMO_CTA_LABEL,
  PROMO_PLACEHOLDER,
  PROMO_PROMPT,
} from "@/shared/lib/promoCopy";
import { fetchEntitlement, redeemPromoCode } from "@/lib/entitlement";
import type { PurchaseFlow } from "@/lib/purchaseFlow";

/**
 * Native mirror of src/components/PurchaseSheet.tsx — the purchase sheet, and
 * the ONLY modal in the paywall flow.
 *
 * Penny's paywall lives in the transcript as a message, deliberately: a sheet
 * thrown over the app on launch is the thing we are not doing. But a purchase
 * IS a modal everywhere else on this platform — this sheet sits directly under
 * Apple's StoreKit sheet, which is modal, dismissible and stops the world, so
 * matching that shape means the two read as one flow rather than two.
 *
 * It renders what it is handed. It does not decide who can buy, what a plan
 * costs, or whether this build can take money at all: the plans and their copy
 * come from `GET /api/me/entitlement`, the PRICES come from Apple, and the
 * server refuses the purchase again on its own authority regardless of what
 * this sheet chose to show.
 *
 * Divergences from the web sheet, and why:
 *
 *  1. It rises from the BOTTOM edge rather than sitting centred in a dimmed
 *     page. StoreKit's sheet is a bottom sheet; a centred card would train the
 *     user on a shape that changes under them the moment they tap.
 *  2. No gradient hairline. The web paints a primary→accent linear-gradient
 *     across the top of the card; RN has no gradient without another native
 *     dependency (same call already made for the chat header avatar), so it is
 *     a flat primary rule.
 *  3. Restore purchases and Manage subscription have no web counterpart at all.
 *     Both are App Store obligations (Guideline 3.1.1 for restore, 3.1.2 for
 *     the management link) and both are meaningless in a browser.
 */
export default function PurchaseSheet({
  flow,
  onClose,
  onRedeemed,
}: {
  /** The whole purchase flow — see `usePurchaseFlow`. */
  flow: PurchaseFlow;
  onClose: () => void;
  /**
   * Fired only after the server has CONFIRMED entitlement, never on the 200
   * from the redeem call. Optional, so a sheet with no promo path renders none.
   */
  onRedeemed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { busy, phase, mode, plans, plansLoading, error, notice } = flow;

  // Backdrop taps and the Android back button both dismiss — except while
  // anything is in flight, where dismissing would leave the account paid up and
  // the UI still paywalled until the next launch. That includes the CONFIRMING
  // phase, which is the important one: the charge has already happened and the
  // sheet is the only thing on screen that knows it.
  const dismiss = () => {
    if (!busy) onClose();
  };

  const purchasingId = phase.kind === "purchasing" ? phase.productId : null;

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
            {/*
              The spinner wins over the fallback prices while the store is being
              asked, even though `plans` already holds the server's list. Showing
              "$2" for a second and then swapping it for "€2,49" is worse than
              waiting: the first number is wrong for that reader, and a price
              that changes under them is the one thing a purchase sheet must
              never do.
            */}
            {plansLoading ? (
              <View style={styles.plansLoading}>
                <ActivityIndicator size="small" color={theme.primary} />
                <Text style={styles.plansLoadingText}>Getting prices from the App Store…</Text>
              </View>
            ) : (
              <View style={styles.plans}>
                {plans.map((p) => (
                  <PlanRow
                    key={p.id}
                    product={p}
                    actionable={mode !== "unavailable"}
                    busy={busy}
                    pending={purchasingId === p.id}
                    onSelect={() => flow.buy(p.id)}
                  />
                ))}
              </View>
            )}

            {/*
              Guideline 3.1.2 wants the subscription's length and price next to
              the thing that buys it, plus reachable Terms and Privacy. The
              length is on each row as the cadence; this is the renewal
              sentence, which a price alone does not say.
            */}
            {mode === "store" ? (
              <Text style={styles.renewalNote}>
                Plans renew automatically until cancelled. Manage or cancel any time in your
                Apple Account.
              </Text>
            ) : null}

            {onRedeemed ? <PromoRedeemer onRedeemed={onRedeemed} /> : null}

            {mode === "test" ? (
              <View style={styles.testNotice}>
                {/* Loud on purpose. This path grants real paid access with
                    no payment, and the one place that must be unmistakable is a
                    screenshot of the sheet that granted it. */}
                <Text style={styles.testNoticeText}>
                  <Text style={styles.testNoticeStrong}>Test purchase — no payment.</Text> Your
                  account is allowlisted, so picking a plan grants it directly and logs a
                  FAKE_PURCHASE event. No money moves, and the App Store is not involved.
                </Text>
              </View>
            ) : null}

            {mode === "unavailable" ? (
              <Text style={styles.notWiredText}>
                The App Store isn&apos;t offering these plans on this build yet — these are the
                prices, not a checkout. If you already have a plan, Restore purchases below will
                still find it.
              </Text>
            ) : null}

            {/*
              Restore is REQUIRED for an auto-renewable subscription (Guideline
              3.1.1), and it is also the only recovery when the entitlement wait
              gives up — so it is shown in every mode, including the one where
              buying is impossible. That is precisely the mode where a user who
              already paid needs it.
            */}
            <View style={styles.secondaryRow}>
              <Pressable
                testID="restore-purchases"
                accessibilityRole="button"
                onPress={flow.restorePurchases}
                disabled={busy}
                style={styles.secondary}
              >
                {phase.kind === "restoring" ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Text style={[styles.secondaryText, busy ? styles.secondaryTextOff : null]}>
                    Restore purchases
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={flow.manageSubscription}
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Manage subscription</Text>
              </Pressable>
            </View>

            <View style={styles.legalRow}>
              <LegalLink label="Terms" path="/terms" />
              <Text style={styles.legalDot}>·</Text>
              <LegalLink label="Privacy" path="/privacy" />
            </View>

            {/*
              Two channels, not one. `notice` is "this happened and nothing is
              wrong" — Ask to Buy waiting on a parent, a restore that found
              nothing, and above all the wait after a real charge. Painting any
              of those red tells somebody who has just paid that it failed.
            */}
            {notice ? (
              <View style={styles.noticeBox}>
                {phase.kind === "confirming" ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : null}
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            ) : null}

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

/**
 * The legal pages live on the web and are deliberately public — no `auth()`
 * call anywhere in the `(legal)` route group, because App Review and Google's
 * brand verification both fetch them anonymously. Opening them in the system
 * browser rather than porting them is the same call the support page makes.
 */
function LegalLink({ label, path }: { label: string; path: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void Linking.openURL(`${API_BASE_URL}${path}`).catch(() => {})}
      hitSlop={8}
    >
      <Text style={styles.legalLink}>{label}</Text>
    </Pressable>
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
      testID={`purchase-${product.id}`}
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

/**
 * The third way through this sheet: a code, instead of a price.
 *
 * Native mirror of the web `PromoRedeemer`. It sits under the two plans because
 * it is the minority path, but it is a peer of them rather than a footnote —
 * hence a real field and a real button, not a "have a code?" link that has to be
 * opened first. Hiding the one control a comped user was told to look for
 * behind a disclosure is a small cruelty.
 *
 * `keyboardShouldPersistTaps="handled"` is already set on the ScrollView above,
 * which is what lets the Redeem button take a tap while the keyboard is up
 * instead of the first tap merely dismissing it.
 */
function PromoRedeemer({ onRedeemed }: { onRedeemed: () => void }) {
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = pending || code.trim().length === 0;

  async function submit() {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await redeemPromoCode(code);
      // The 200 says a row was written. Entitlement is a different question and
      // the server is the one that answers it — believing the first would
      // unblock the app on our own say-so.
      const fresh = await fetchEntitlement();
      if (!fresh?.entitled) {
        setError("That worked, but your plan hasn't switched on yet. Give it a moment.");
        return;
      }
      onRedeemed();
    } catch (err) {
      // The server sends copy per refusal code, and it already says the useful
      // thing — which address, or that the code is spent. Rendered verbatim
      // rather than re-worded here, so there is one place to change it.
      setError(err instanceof Error ? err.message : "Could not redeem that code");
    } finally {
      setPending(false);
    }
  }

  return (
    <View testID="promo-redeemer" style={styles.promoWrap}>
      <View style={styles.promoDivider}>
        <View style={styles.promoRule} />
        <Text style={styles.promoLabel}>{PROMO_PROMPT.toUpperCase()}</Text>
        <View style={styles.promoRule} />
      </View>

      <View style={styles.promoRow}>
        <TextInput
          testID="promo-input"
          value={code}
          onChangeText={setCode}
          placeholder={PROMO_PLACEHOLDER}
          placeholderTextColor={theme.subtle}
          // No autocapitalize fight and no autocorrect: the server normalizes,
          // and a keyboard "helpfully" rewriting a random string is how a valid
          // code arrives mangled.
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!pending}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          style={styles.promoInput}
        />
        <Pressable
          testID="promo-submit"
          accessibilityRole="button"
          onPress={() => void submit()}
          disabled={disabled}
          style={[styles.promoButton, disabled ? styles.promoButtonOff : null]}
        >
          {pending ? (
            <ActivityIndicator size="small" color={theme.onPrimary} />
          ) : (
            <Text style={[styles.promoButtonText, disabled ? styles.promoButtonTextOff : null]}>
              {PROMO_CTA_LABEL}
            </Text>
          )}
        </Pressable>
      </View>

      {error ? (
        <Text testID="promo-error" style={styles.promoError}>
          {error}
        </Text>
      ) : null}
    </View>
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
  plansLoading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 },
  plansLoadingText: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
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

  renewalNote: {
    marginTop: 10,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 17,
    color: theme.subtle,
  },

  secondaryRow: {
    marginTop: 14,
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    columnGap: 18,
  },
  secondary: { paddingVertical: 8, alignItems: "center", minHeight: 34, justifyContent: "center" },
  secondaryText: { fontFamily: font.semibold, fontSize: 13, color: theme.primary },
  secondaryTextOff: { opacity: 0.45 },

  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8 },
  legalLink: { fontFamily: font.regular, fontSize: 11.5, color: theme.subtle },
  legalDot: { fontFamily: font.regular, fontSize: 11.5, color: theme.subtle },

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

  promoWrap: { marginTop: 14 },
  promoDivider: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  promoRule: { flex: 1, height: 1, backgroundColor: theme.border },
  promoLabel: { fontFamily: font.regular, fontSize: 10.5, letterSpacing: 0.8, color: theme.subtle },
  promoRow: { flexDirection: "row", gap: 6 },
  promoInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    color: theme.text,
    fontFamily: font.regular,
    fontSize: 13,
  },
  promoButton: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 82,
  },
  promoButtonOff: { backgroundColor: theme.border },
  promoButtonText: { fontFamily: font.semibold, fontSize: 13, color: theme.onPrimary },
  promoButtonTextOff: { color: theme.subtle },
  promoError: {
    marginTop: 8,
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 17,
    color: theme.danger,
  },

  notWiredText: {
    marginTop: 14,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    color: theme.muted,
  },

  /* Deliberately NOT the danger palette — see the two-channels note above. */
  noticeBox: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
  },
  noticeText: { flex: 1, fontFamily: font.regular, fontSize: 12, lineHeight: 18, color: theme.text },

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
