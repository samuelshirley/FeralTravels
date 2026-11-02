import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { shadow, theme } from "@/lib/theme";

/**
 * The card every intro preview is drawn in, at a FIXED logical size and then
 * scaled to the screen. Laying the preview out once at 340 × 500 and scaling
 * the result is what keeps it identical on every iPhone: text wraps the same
 * way, rows land in the same place, nothing reflows on an SE.
 *
 * The scale is the smaller of 85% of the window's width and 55% of its height
 * (iPhone SE, 375 × 667: 0.73), capped at 1.15 so a Pro Max does not blow the
 * text up past the app's own sizes. The wrapper is sized to the SCALED box,
 * because a transform does not change layout: without it the page would
 * reserve the unscaled 500pt and push the headline and buttons off an SE.
 */
export const PREVIEW_W = 340;
export const PREVIEW_H = 500;
const MAX_SCALE = 1.15;

export function previewScale(window: { width: number; height: number }): number {
  return Math.min((window.width * 0.85) / PREVIEW_W, (window.height * 0.55) / PREVIEW_H, MAX_SCALE);
}

export default function PreviewFrame({
  label,
  children,
}: {
  /** What the preview shows, as one sentence — the preview is ONE accessible element. */
  label: string;
  children: ReactNode;
}) {
  const window = useWindowDimensions();
  const s = previewScale(window);
  return (
    <View
      style={{ width: PREVIEW_W * s, height: PREVIEW_H * s }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.card,
          {
            // A transform scales about the centre; shift the unscaled box so
            // its centre sits on the wrapper's.
            left: (PREVIEW_W * s - PREVIEW_W) / 2,
            top: (PREVIEW_H * s - PREVIEW_H) / 2,
            transform: [{ scale: s }],
          },
        ]}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {/* Clipped INSIDE the shadowed card: on iOS `overflow: hidden` on the
            view that casts the shadow clips the shadow away too. */}
        <View style={styles.clip}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    width: PREVIEW_W,
    height: PREVIEW_H,
    // The app's own ground: the preview is a small screenshot of a screen,
    // so its bubbles and day cards sit on what they sit on in the app.
    backgroundColor: theme.bg,
    borderRadius: theme.radiusLg,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    ...shadow.md,
  },
  clip: { flex: 1, borderRadius: theme.radiusLg - 1, overflow: "hidden" },
});
