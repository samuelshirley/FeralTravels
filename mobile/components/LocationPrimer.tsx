import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The sheet shown at launch, over the Finn splash, before iOS's location
 * dialog — and only when iOS has not been asked yet (shared/lib/launchLocation).
 *
 * ONE CONTROL, and it always leads to the system dialog. App Review 5.1.1(iv):
 * a pre-permission screen may explain, but it may not offer a way past the
 * system prompt. Build 12's version had "Turn on location" and "Not now", and
 * "Not now" skipped the dialog — that is the rejection pattern, and its whole
 * design (spend the one-shot OS prompt only on someone who already said yes)
 * is what Apple forbids. The user's real choice is Allow or Don't Allow, in
 * iOS's own dialog, and the app does not go on until they make it.
 *
 * There is no dismiss either: `onRequestClose` (Android's back button) is
 * Continue, not a skip. locationPrimerGuard.test.ts holds all of this.
 *
 * Sheet chrome is AnnouncementModal's, so the app has one modal language.
 */
export default function LocationPrimer({
  visible,
  onContinue,
}: {
  visible: boolean;
  onContinue: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="location-primer">
          <View style={styles.accentBar}>
            <View style={[styles.accentHalf, { backgroundColor: theme.primary }]} />
            <View style={[styles.accentHalf, { backgroundColor: theme.accentWarm }]} />
          </View>

          <View style={styles.body}>
            <Text style={styles.title}>Know where you are on the route</Text>
            <Text style={styles.bodyText}>
              With location, Feral Travels knows which day you&apos;re on and which stop is next
              — and Finn plans fuel from where you actually are, not from where the plan says you
              should be.
            </Text>
            <Text style={styles.note}>
              iOS asks next. You can change your answer later in Settings.
            </Text>

            <Pressable
              accessibilityRole="button"
              onPress={onContinue}
              style={styles.cta}
              testID="location-primer-continue"
            >
              <Text style={styles.ctaText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Matches AnnouncementModal, which matches the web's hard-coded value.
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusMd,
    overflow: "hidden",
    ...shadow.md,
  },
  accentBar: { height: 4, flexDirection: "row" },
  accentHalf: { flex: 1 },
  body: { paddingTop: 28, paddingHorizontal: 24, paddingBottom: 20 },
  title: {
    fontSize: 20,
    fontFamily: font.bold,
    color: theme.text,
    marginBottom: 12,
    lineHeight: 26,
  },
  bodyText: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 22,
    color: theme.muted,
    marginBottom: 12,
  },
  note: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: theme.subtle,
    marginBottom: 24,
  },
  cta: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primary,
    alignItems: "center",
  },
  ctaText: { fontSize: 14, fontFamily: font.semibold, color: theme.onPrimary },
});
