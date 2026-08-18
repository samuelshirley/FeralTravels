import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError } from "@/lib/api";
import { useUnits } from "@/lib/units";
import { theme } from "@/lib/theme";
import type { UnitsPref } from "@/shared/lib/units";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/components/UnitsToggle.tsx.
 *
 * Two-button segmented toggle for the user's metric/imperial display
 * preference. Tapping writes through to /api/me/preferences via UnitsProvider,
 * which also updates every other consumer (Distance, the vehicle form labels,
 * Penny's onboarding prompts on the next load).
 *
 * The web marks the strip `role="tablist"` with `aria-selected` children;
 * `accessibilityRole="tab"` + `accessibilityState.selected` is the native
 * equivalent, so VoiceOver announces the same "selected, 1 of 2".
 */
export default function UnitsToggle() {
  const { units, setUnits, loading } = useUnits();
  const [error, setError] = useState<string | null>(null);

  async function pick(next: UnitsPref) {
    if (next === units || loading) return;
    setError(null);
    try {
      // Optimistic: setUnits flips local state before the PATCH lands and
      // rolls itself back on failure, so we only have to render the message.
      await setUnits(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update preference.");
    }
  }

  return (
    <View>
      <Text style={styles.caption}>
        Display units —{" "}
        <Text style={styles.captionSubtle}>
          stored values are always metric; this just changes what you see.
        </Text>
      </Text>
      <View style={styles.strip} accessibilityLabel="Display units">
        {(["metric", "imperial"] as const).map((u, i) => {
          const active = units === u;
          return (
            <Pressable
              key={u}
              accessibilityRole="tab"
              accessibilityState={{ selected: active, disabled: loading }}
              onPress={() => {
                void pick(u);
              }}
              disabled={loading}
              style={[
                styles.segment,
                i > 0 && styles.segmentDivider,
                active && styles.segmentActive,
                loading && !active && styles.segmentDimmed,
              ]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {u === "metric" ? "Metric (km)" : "Imperial (mi)"}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { fontFamily: font.regular, fontSize: 12, color: theme.muted, marginBottom: 6, lineHeight: 17 },
  captionSubtle: { color: theme.subtle },
  // `alignSelf: flex-start` reproduces the web's `display: inline-flex` — the
  // strip hugs its two buttons instead of stretching across the card.
  strip: {
    flexDirection: "row",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
    overflow: "hidden",
  },
  segment: { paddingVertical: 7, paddingHorizontal: 14 },
  segmentDivider: { borderLeftWidth: 1, borderLeftColor: theme.border },
  segmentActive: { backgroundColor: theme.primary },
  segmentDimmed: { opacity: 0.6 },
  segmentText: { fontSize: 12, fontFamily: font.semibold, letterSpacing: 0.5, color: theme.muted },
  segmentTextActive: { color: theme.onPrimary },
  error: { fontFamily: font.regular, marginTop: 6, fontSize: 12, color: theme.danger },
});
