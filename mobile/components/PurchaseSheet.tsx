import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_BASE_URL } from "@/lib/config";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";
import type { PurchaseFlow } from "@/lib/purchaseFlow";
import { unavailableMessage, type SheetPlan } from "@/shared/lib/purchaseMode";

/**
 * Guideline 3.1.2(c)'s renewal terms, verbatim on every purchase surface and in
 * every mode. Exported so `purchaseDisclosureGuard.test.ts` can hold the
 * wording and its placement.
 */
export const AUTO_RENEW_DISCLOSURE =
  "Payment is charged to your Apple Account at confirmation of purchase. Subscriptions renew " +
  "automatically unless cancelled at least 24 hours before the end of the current period. " +
  "Manage or cancel in your Apple Account settings.";

/**
 * The developer's five-way reading of an unavailable sheet — dev builds ONLY.
 *
 * This exact shape is load-bearing: Metro inlines `__DEV__` as `false` in a
 * release bundle and folds the dead branch away before it collects
 * dependencies, so the module and its sentences are not in a TestFlight or App
 * Store binary at all. A static `import` would put them back. Held by
 * `src/lib/purchaseCopyGuard.test.ts` and by the release-bundle check in the
 * Mobile typecheck CI job.
 */
const purchaseDiagnostics: typeof import("@/shared/lib/purchaseDiagnostics") | null = __DEV__
  ? require("@/shared/lib/purchaseDiagnostics")
  : null;

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
 *  4. No promo-code field. The web's promo box unlocks the paid tier
 *     through our own promo endpoint, which on iOS is a Guideline 3.1.1
 *     rejection (digital access sold or granted outside in-app purchase). Codes
 *     on iOS are App Store offer codes, redeemed in Apple's own sheet — the
 *     "Redeem offer code" control below. `iosPromoRedeemGuard.test.ts`.
 *
 * Fits a short window. App Review used an iPad in iPhone compatibility mode, a
 * window shorter than any iPhone the layout was drawn on: everything below the
 * header is in ONE ScrollView that shrinks to the sheet's max height, and
 * nothing in it has a fixed height.
 */
export default function PurchaseSheet({
  flow,
  onClose,
}: {
  /** The whole purchase flow — see `usePurchaseFlow`. */
  flow: PurchaseFlow;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  // A legal page that would not open. Shown INSIDE the sheet: the app's global
  // toast (ErrorProvider) renders under a Modal, where nobody would see it.
  const [linkError, setLinkError] = useState<string | null>(null);
  const {
    busy,
    phase,
    mode,
    unavailableReason,
    manageSubscriptionAvailable,
    plans,
    plansLoading,
    error,
    notice,
  } = flow;

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
      <Pressable style={styles.backdrop} onPress={dismiss} accessible={false}>
        {/* accessible={false} on BOTH wrappers, or iOS merges the whole sheet into
            one accessibility element and nothing inside it — Close, the plan
            rows, Restore — exists for VoiceOver or Maestro (the trips menu,
            app/trips/index.tsx, has the long version; modalMergeGuard.test.ts). */}
        {/* Swallow taps inside the sheet so reading a price doesn't dismiss
            the thing the user is trying to read. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}
          onPress={() => {}}
          accessible={false}
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
              Rows ONLY in store mode, and only ever with the store's prices.
              `flow.plans` is empty in every other mode — the type says so
              (`ResolvedPurchaseMode`) — because the server's fallbacks are US
              prices with nothing behind them: "$2.69" in front of somebody
              Apple will charge €2, with no renewal terms, is the 3.1.2 problem.
            */}
            {plansLoading ? (
              <View style={styles.plansLoading}>
                <ActivityIndicator size="small" color={theme.primary} />
                <Text style={styles.plansLoadingText}>Getting prices from the App Store…</Text>
              </View>
            ) : mode === "store" ? (
              <View style={styles.plans}>
                {plans.map((p) => (
                  <PlanRow
                    key={p.id}
                    product={p}
                    busy={busy}
                    pending={purchasingId === p.id}
                    onSelect={() => flow.buy(p.id)}
                  />
                ))}
              </View>
            ) : null}

            {/*
              Guideline 3.1.2(c): the renewal terms, in every mode — not only
              when rows are tappable. Each row carries the title, length and
              price; this says how the charge and the renewal work.
            */}
            <Text testID="purchase-renewal-terms" style={styles.renewalNote}>
              {AUTO_RENEW_DISCLOSURE}
            </Text>

            {/*
              The customer's line says what THEY can do and never why we cannot
              sell — see `unavailableMessage`. In a dev build the reason is
              printed beneath it, because "no key in this build", "StoreKit
              resolved nothing" (App Store Connect) and "the ids do not match"
              are fixed in three different places. Nothing while the store is
              still being asked: the spinner above already says so.
            */}
            {mode === "unavailable" && unavailableReason ? (
              <Text testID="purchase-unavailable" style={styles.notWiredText}>
                {unavailableMessage(unavailableReason)}
              </Text>
            ) : null}
            {purchaseDiagnostics && mode === "unavailable" && unavailableReason ? (
              <Text testID="purchase-unavailable-diagnostic" style={styles.devDiagnosticText}>
                {`DEV · ${purchaseDiagnostics.PURCHASE_DIAGNOSTICS_SENTINEL}\n`}
                {purchaseDiagnostics.unavailableDiagnostic(unavailableReason)}
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
              {/*
                App Store offer codes, redeemed in Apple's own sheet — the only
                code path on iOS (Guideline 3.1.1). Access arrives the way a
                purchase's does: a webhook, then the server poll. iOS only:
                there is no such sheet anywhere else.
              */}
              {Platform.OS === "ios" ? (
                <Pressable
                  testID="redeem-offer-code"
                  accessibilityRole="button"
                  onPress={flow.redeemOfferCode}
                  disabled={busy}
                  style={styles.secondary}
                >
                  <Text style={[styles.secondaryText, busy ? styles.secondaryTextOff : null]}>
                    Redeem offer code
                  </Text>
                </Pressable>
              ) : null}
              {/*
                Only for an account with a subscription at Apple. The link is
                Apple's own subscriptions screen, which for a trial account —
                no row has ever existed — is an empty list. Guideline 3.1.2
                wants the management screen REACHABLE for subscribers, and it
                is: the flag is true for every state that implies an Apple
                row, live or lapsed, and flips on the fresh payload the
                caller stores after a purchase.
              */}
              {manageSubscriptionAvailable ? (
                <Pressable
                  testID="manage-subscription"
                  accessibilityRole="button"
                  onPress={flow.manageSubscription}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryText}>Manage subscription</Text>
                </Pressable>
              ) : null}
            </View>

            {/*
              Guideline 3.1.2(c) wants functional links to the Terms of Use
              (EULA) and the Privacy Policy on the sheet, and App Review has to
              be able to SEE them: primary-coloured, underlined, full names.
            */}
            <View style={styles.legalRow}>
              <LegalLink
                testID="purchase-terms-link"
                label="Terms of Use (EULA)"
                path="/terms"
                onError={setLinkError}
              />
              <LegalLink
                testID="purchase-privacy-link"
                label="Privacy Policy"
                path="/privacy"
                onError={setLinkError}
              />
            </View>
            {linkError ? (
              <Text testID="purchase-link-error" accessibilityRole="alert" style={styles.linkError}>
                {linkError}
              </Text>
            ) : null}

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
function LegalLink({
  label,
  path,
  testID,
  onError,
}: {
  label: string;
  path: string;
  testID: string;
  /** Never swallowed: the reader is told the address, so they can type it. */
  onError: (message: string) => void;
}) {
  const url = `${API_BASE_URL}${path}`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      onPress={() => {
        onError("");
        void Linking.openURL(url).catch(() =>
          onError(`Couldn't open ${label}. It's at ${url}`)
        );
      }}
      hitSlop={8}
    >
      <Text style={styles.legalLink}>{label}</Text>
    </Pressable>
  );
}

/**
 * One plan, as Apple sells it: title, price and cadence, and the length — plus
 * the per-month figure on the annual plan. Rendered only in store mode, so it
 * is always a real purchase control.
 */
function PlanRow({
  product,
  busy,
  pending,
  onSelect,
}: {
  product: SheetPlan;
  busy: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  // The title is the subscription's own name, above its price and length —
  // the things Guideline 3.1.2(c) wants together. Without it the row was a
  // price under the APP's name, and 1.0 (12) was rejected for exactly that.
  const detail = product.perMonth ? `${product.length} · ${product.perMonth}` : product.length;
  return (
    <Pressable
      testID={`purchase-${product.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${product.title}, ${product.priceLabel} ${product.cadence}, ${detail}`}
      onPress={onSelect}
      disabled={busy}
      style={[styles.planRow, busy && !pending ? styles.planRowDim : null]}
    >
      <View style={styles.planCopy}>
        <Text testID={`plan-title-${product.period}`} style={styles.planTitle}>
          {product.title}
        </Text>
        <View style={styles.planPrice}>
          <Text style={styles.planPriceLabel}>{product.priceLabel}</Text>
          <Text style={styles.planCadence}>{product.cadence}</Text>
        </View>
        <Text testID={`plan-length-${product.period}`} style={styles.planDetail}>
          {detail}
        </Text>
      </View>
      <View style={styles.planTrailing}>
        {product.note ? (
          <View style={styles.planNote}>
            <Text style={styles.planNoteText}>{product.note}</Text>
          </View>
        ) : null}
        {pending ? <ActivityIndicator size="small" color={theme.primary} /> : null}
      </View>
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

  // Shrinks to whatever the sheet's maxHeight leaves after the header, and
  // never grows past its content: a short window scrolls instead of clipping.
  scroll: { marginTop: 18, flexGrow: 0, flexShrink: 1 },
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
  planCopy: { gap: 2, minWidth: 0, flexShrink: 1 },
  planTitle: { fontFamily: font.medium, fontSize: 13, color: theme.text },
  planPrice: { flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0, flexShrink: 1 },
  planPriceLabel: { fontFamily: font.bold, fontSize: 17, color: theme.text },
  planCadence: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  planDetail: { fontFamily: font.regular, fontSize: 12.5, color: theme.muted },
  planTrailing: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  planNote: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: theme.successMuted,
  },
  planNoteText: { fontFamily: font.semibold, fontSize: 11, color: theme.success },

  renewalNote: {
    marginTop: 12,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.muted,
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

  legalRow: {
    marginTop: 4,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 18,
    rowGap: 6,
  },
  linkError: {
    marginTop: 6,
    textAlign: "center",
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.danger,
  },
  legalLink: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: theme.primary,
    textDecorationLine: "underline",
    paddingVertical: 6,
  },

  notWiredText: {
    marginTop: 14,
    fontFamily: font.regular,
    fontSize: 12.5,
    lineHeight: 19,
    color: theme.muted,
  },
  // Dev builds only. Monospace so it reads as a log line, not as copy.
  devDiagnosticText: {
    marginTop: 8,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 16,
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
