import { useEffect } from "react";
import { Keyboard, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_BASE_URL } from "@/lib/config";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";
import { Spinner } from "@/components/ui";
import { AI_CONSENT_COPY, PRIVACY_POLICY_PATH } from "@/shared/lib/aiConsent";

/**
 * "Penny uses Anthropic and TypeSafe" — asked before the first message,
 * photo or trip detail reaches Penny (App Review 5.1.2(i)), and once more for
 * an account that agreed to the older, Anthropic-only sheet (`upgrade`): it
 * says what changed, and its decline reads "Anthropic only" because that is
 * what it does. See lib/useAiConsent.ts for when it opens and what each
 * answer does.
 *
 * No backdrop dismiss: the guideline asks for an explicit answer, so the only
 * ways out are the two buttons (and the hardware back gesture, which is
 * "Not now"). No Pressable wraps another, so every control stays its own
 * accessibility element for VoiceOver and Maestro (modalMergeGuard.test.ts).
 */
export default function AiConsentSheet({
  saving,
  error,
  upgrade = false,
  onAgree,
  onNotNow,
}: {
  saving: boolean;
  error: string | null;
  upgrade?: boolean;
  onAgree: () => void;
  onNotNow: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The sheet opens on a tap of Send, usually with the keyboard up; on iOS the
  // keyboard sits above a modal and would cover Agree / Not now.
  useEffect(() => {
    Keyboard.dismiss();
  }, []);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => (saving ? undefined : onNotNow())}>
      <View style={styles.backdrop}>
        <View testID="ai-consent-sheet" style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
          <View style={styles.grabber} />
          <Text testID="ai-consent-title" style={styles.title}>
            {AI_CONSENT_COPY.title}
          </Text>
          {upgrade ? (
            <Text testID="ai-consent-upgrade" style={styles.lead}>
              {AI_CONSENT_COPY.upgradeLead}
            </Text>
          ) : null}
          <Text testID="ai-consent-body" style={styles.body}>
            {AI_CONSENT_COPY.body}
          </Text>
          <Text testID="ai-consent-typesafe" style={styles.body}>
            {AI_CONSENT_COPY.typeSafeBody}
          </Text>
          <Pressable
            testID="ai-consent-privacy"
            accessibilityRole="link"
            onPress={() => void Linking.openURL(`${API_BASE_URL}${PRIVACY_POLICY_PATH}`).catch(() => {})}
            hitSlop={8}
            style={styles.linkWrap}
          >
            <Text style={styles.link}>{AI_CONSENT_COPY.privacyLink}</Text>
          </Pressable>
          {error ? (
            <Text testID="ai-consent-error" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <Pressable
              testID="ai-consent-not-now"
              accessibilityRole="button"
              onPress={onNotNow}
              disabled={saving}
              style={[styles.button, styles.secondary, saving ? styles.off : null]}
            >
              <Text style={styles.secondaryText}>
                {upgrade ? AI_CONSENT_COPY.notNowUpgrade : AI_CONSENT_COPY.notNow}
              </Text>
            </Pressable>
            <Pressable
              testID="ai-consent-agree"
              accessibilityRole="button"
              onPress={onAgree}
              disabled={saving}
              style={[styles.button, styles.primary, saving ? styles.off : null]}
            >
              {saving ? <Spinner /> : <Text style={styles.primaryText}>{AI_CONSENT_COPY.agree}</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.overlay, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: theme.radiusLg,
    borderTopRightRadius: theme.radiusLg,
    paddingHorizontal: 20,
    paddingTop: 8,
    ...shadow.md,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginBottom: 14,
  },
  title: { fontFamily: font.bold, fontSize: 18, color: theme.text },
  lead: { fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: theme.text, marginTop: 10 },
  body: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: theme.muted, marginTop: 10 },
  linkWrap: { alignSelf: "flex-start", marginTop: 10 },
  link: { fontFamily: font.medium, fontSize: 13, color: theme.accent400, textDecorationLine: "underline" },
  error: { fontFamily: font.regular, fontSize: 13, color: theme.warning, marginTop: 12 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 20 },
  button: {
    flex: 1,
    minHeight: 44,
    borderRadius: theme.radiusSm,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: theme.primary },
  primaryText: { fontFamily: font.bold, fontSize: 15, color: theme.onPrimary },
  secondary: { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface },
  secondaryText: { fontFamily: font.medium, fontSize: 15, color: theme.text },
  off: { opacity: 0.5 },
});
