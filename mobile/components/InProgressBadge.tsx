import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * "In progress" on a feature request: the words plus three dots in a small
 * bubble, like a messaging app's typing indicator. Sits in the card's
 * bottom-right corner (FeatureRequestCard reserves the space).
 *
 * The dots hold still under Reduce Motion — the words carry the meaning, the
 * motion is decoration. One element for VoiceOver: "In progress".
 */
const DOT_COUNT = 3;
const STAGGER_MS = 150;
const CYCLE_MS = 1200;

interface Props {
  /** Carried into the testID: the flow addresses ITS request's badge. */
  requestId: string;
}

export default function InProgressBadge({ requestId }: Props) {
  const [reduceMotion, setReduceMotion] = useState(false);
  const values = useRef(Array.from({ length: DOT_COUNT }, () => new Animated.Value(0))).current;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (mounted) setReduceMotion(on);
      })
      .catch(() => {
        // Unknown → animate; the words still say "In progress" either way.
      });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      values.forEach((v) => v.setValue(0.6));
      return;
    }
    const half = (CYCLE_MS - STAGGER_MS * DOT_COUNT) / 2;
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * STAGGER_MS),
          Animated.timing(v, { toValue: 1, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.delay((DOT_COUNT - 1 - i) * STAGGER_MS),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [reduceMotion, values]);

  return (
    <View style={styles.row} accessible accessibilityLabel="In progress" testID={`feature-request-in-progress-${requestId}`}>
      <Text style={styles.label}>In progress</Text>
      <View style={styles.bubble}>
        {values.map((v, i) => (
          <Animated.View
            key={i}
            style={[
              styles.dot,
              {
                opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
                transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }],
              },
            ]}
          />
        ))}
        <View style={styles.tailBig} />
        <View style={styles.tailSmall} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 7 },
  label: { fontFamily: font.semibold, fontSize: 10.5, letterSpacing: 0.2, color: theme.accent300 },
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.accent900,
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: theme.accent300 },
  tailBig: {
    position: "absolute",
    left: -2,
    bottom: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.accent900,
  },
  tailSmall: {
    position: "absolute",
    left: -6,
    bottom: -6,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.accent900,
  },
});
