import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * In-app explainer shown immediately before the iOS location alert.
 *
 * iOS gives an app exactly one shot at that alert. A "Don't Allow" there is
 * only reversible through Settings, which almost nobody does — so the OS
 * prompt is spent only on someone who has already said yes in UI we control,
 * where "Not now" is cheap and recoverable. This is why the ask stays inside
 * the trip workspace rather than moving to cold start: here the user has seen
 * their route, so the reason for asking is legible.
 *
 * Sheet chrome is AnnouncementModal's, so the app has one modal language.
 */
export default function LocationPrimer({
  visible,
  onEnable,
  onDecline,
}: {
  visible: boolean;
  onEnable: () => void;
  onDecline: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.accentBar}>
            <View style={[styles.accentHalf, { backgroundColor: theme.primary }]} />
            <View style={[styles.accentHalf, { backgroundColor: theme.accentWarm }]} />
          </View>

          <View style={styles.body}>
            <Text style={styles.title}>Know where you are on the route?</Text>
            <Text style={styles.bodyText}>
              With location on, Feral Travels knows which day you&apos;re on and which stop is
              next — and Finn can plan fuel from where you actually are, not from where the plan
              says you should be.
            </Text>
            <Text style={styles.note}>
              iOS will ask you to confirm on the next screen. You can change this any time.
            </Text>

            <Pressable accessibilityRole="button" onPress={onEnable} style={styles.cta}>
              <Text style={styles.ctaText}>Turn on location</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onDecline} style={styles.secondary}>
              <Text style={styles.secondaryText}>Not now</Text>
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
  secondary: { paddingVertical: 12, alignItems: "center" },
  secondaryText: { fontSize: 14, fontFamily: font.medium, color: theme.muted },
});
