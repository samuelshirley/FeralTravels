import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The 3-dot typing bubble — native form of `.typing-indicator-bubble` /
 * `@keyframes tp-typing-bounce` in src/app/layout.tsx: a 1.2s bounce to -8px,
 * staggered 0.2s per dot.
 */
export function TypingBubble() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          // 0 → 1 → 0 over the first 60% of the cycle, flat for the rest.
          Animated.timing(v, {
            toValue: 1,
            duration: 360,
            easing: Easing.bezier(0.45, 0.05, 0.55, 0.95),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: 360,
            easing: Easing.bezier(0.45, 0.05, 0.55, 0.95),
            useNativeDriver: true,
          }),
          Animated.delay(480 - i * 200),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.bubble} accessibilityLabel="Penny is typing">
      {dots.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) }] },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * The blinking caret at the tail of a streaming bubble — native form of
 * `@keyframes tp-cursor-blink` (a hard on/off at 50%, not a fade), so it reads
 * as a terminal cursor rather than a pulsing glow.
 *
 * Rendered as an Animated.TEXT, not a View: it has to sit inline after the last
 * word of Penny's reply and reflow with it. Nested <Text> is the only reliably
 * inline-flowing child on both platforms — a View inside Text lays out
 * inconsistently on Android.
 */
export function BlinkingCursor() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 0,
          delay: 500,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 0,
          delay: 500,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.Text style={[styles.cursor, { opacity }]} accessibilityElementsHidden>
      {"▌"}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  bubble: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: theme.surface,
    marginTop: 10,
  },
  // src/app/layout.tsx:218 — .typing-indicator-dot background.
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#86868b" },
  cursor: { fontFamily: font.regular, color: theme.muted, fontSize: 14, lineHeight: 21 },
});
