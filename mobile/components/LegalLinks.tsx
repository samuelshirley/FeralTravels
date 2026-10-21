import { useCallback } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { API_BASE_URL } from "@/lib/config";
import { useErrors } from "@/lib/errors";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The Privacy Policy and Terms of Use, reachable from outside the purchase
 * sheet (Guidelines 5.1.1(i) and 3.1.2(c)).
 *
 * Until 2026-10-20 the only way into either from the app was the sheet's
 * footer, which a user only sees when they are being sold something. Apple
 * wants the policy "easily accessible" in the app; Settings and the sign-in
 * screen are where a person (and a reviewer) looks.
 *
 * Both open the public web pages in the system browser, the same as the sheet:
 * the `(legal)` route group calls no `auth()`, so they render signed out, and
 * one copy of each document is one copy to keep true.
 *
 * A URL that will not open is said, not swallowed — the toast names the
 * address so it can be typed by hand.
 */
export type LegalPage = "privacy" | "terms";

export const LEGAL_PAGES: Record<LegalPage, { path: string; label: string }> = {
  privacy: { path: "/privacy", label: "Privacy Policy" },
  terms: { path: "/terms", label: "Terms of Use" },
};

export function legalPageUrl(page: LegalPage): string {
  return `${API_BASE_URL}${LEGAL_PAGES[page].path}`;
}

export function useOpenLegalPage(): (page: LegalPage) => void {
  const { notify } = useErrors();
  return useCallback(
    (page: LegalPage) => {
      const url = legalPageUrl(page);
      Linking.openURL(url).catch(() => {
        notify(`Couldn’t open the ${LEGAL_PAGES[page].label}. It’s at ${url}`);
      });
    },
    [notify]
  );
}

/** Settings: a titled block with one row per document. */
export function LegalSection() {
  const open = useOpenLegalPage();
  return (
    <View style={styles.section} testID="settings-legal-section">
      <Text style={styles.sectionTitle}>Legal</Text>
      <Pressable
        testID="settings-privacy-link"
        accessibilityRole="link"
        onPress={() => open("privacy")}
        style={styles.row}
      >
        <Text style={styles.rowText}>{LEGAL_PAGES.privacy.label}</Text>
      </Pressable>
      <Pressable
        testID="settings-terms-link"
        accessibilityRole="link"
        onPress={() => open("terms")}
        style={styles.row}
      >
        <Text style={styles.rowText}>{LEGAL_PAGES.terms.label}</Text>
      </Pressable>
    </View>
  );
}

/**
 * Sign-in: the quiet pair under the card, mirroring the web /login footer
 * ("Privacy · Terms").
 */
export function LegalFooter() {
  const open = useOpenLegalPage();
  return (
    <View style={styles.footer}>
      <Pressable
        testID="signin-privacy-link"
        accessibilityRole="link"
        accessibilityLabel={LEGAL_PAGES.privacy.label}
        onPress={() => open("privacy")}
        hitSlop={8}
      >
        <Text style={styles.footerLink}>Privacy</Text>
      </Pressable>
      <Text style={styles.footerDot}>·</Text>
      <Pressable
        testID="signin-terms-link"
        accessibilityRole="link"
        accessibilityLabel={LEGAL_PAGES.terms.label}
        onPress={() => open("terms")}
        hitSlop={8}
      >
        <Text style={styles.footerLink}>Terms</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Same rhythm as LocationSection and the Settings sections around it.
  section: { paddingVertical: 20 },
  sectionTitle: { fontSize: 17, fontFamily: font.medium, color: theme.text, marginBottom: 6 },
  // The quiet text-link treatment of Restore / Manage in SubscriptionSection.
  row: { paddingVertical: 8, minHeight: 34, justifyContent: "center", alignSelf: "flex-start" },
  rowText: { fontFamily: font.medium, fontSize: 13, color: theme.primary },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  footerLink: { fontFamily: font.regular, fontSize: 12, color: theme.subtle },
  footerDot: { fontFamily: font.regular, fontSize: 12, color: theme.subtle },
});
