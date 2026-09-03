import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { formatKmDual } from "@/shared/lib/units";
import { STATUS_MAP, type LegStatus } from "@/shared/types/trip";
import { useUnits } from "@/lib/units";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/** Small eyebrow label — the web's letterspaced all-caps kicker. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Spinner({ size = "small" }: { size?: "small" | "large" }) {
  return <ActivityIndicator color={theme.primary} size={size} />;
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

/** Mirrors src/components/StatusBadge.tsx. */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status as LegStatus] || STATUS_MAP.planning;
  return (
    <View style={[styles.badge, { backgroundColor: s.bg, borderColor: s.border }]}>
      <Text style={[styles.badgeText, { color: s.text }]}>{s.label}</Text>
    </View>
  );
}

/**
 * Mirrors src/components/Distance.tsx — km stays the primary label even for
 * imperial users (the product decision is to teach metric); miles ride along
 * as a smaller secondary label.
 */
export function Distance({
  km,
  layout = "stacked",
  primaryOverride,
  style,
}: {
  km: number | null | undefined;
  layout?: "inline" | "stacked";
  primaryOverride?: string;
  style?: ViewStyle;
}) {
  const { units } = useUnits();
  const { primary, secondary } = formatKmDual(km, units);
  const primaryText = primaryOverride ?? primary;

  if (!secondary) return <Text style={style as never}>{primaryText}</Text>;

  if (layout === "inline") {
    return (
      <Text style={style as never}>
        {primaryText} <Text style={styles.distanceSecondaryInline}>{secondary}</Text>
      </Text>
    );
  }
  return (
    <View style={[styles.distanceStack, style]}>
      <Text>{primaryText}</Text>
      <Text style={styles.distanceSecondary}>{secondary}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  busy,
  disabled,
  variant = "primary",
  style,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  style?: ViewStyle;
}) {
  const isOff = busy || disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={isOff}
      style={({ pressed }) => [
        styles.button,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        pressed && !isOff && styles.buttonPressed,
        pressed && !isOff && variant === "secondary" && styles.buttonSecondaryPressed,
        pressed && !isOff && variant === "danger" && styles.buttonDangerPressed,
        isOff && styles.buttonDisabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={
            variant === "secondary"
              ? theme.text
              : variant === "danger"
                ? theme.danger
                : theme.accent300
          }
        />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant === "secondary" && styles.buttonTextSecondary,
            variant === "danger" && styles.buttonTextDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Banner({
  tone,
  title,
  body,
  action,
}: {
  tone: "info" | "warning" | "danger" | "success";
  title?: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  const palette = {
    // Borders come from STATUS_MAP in src/types/trip.ts:461-464 (planning /
    // research / confirmed) plus the ubiquitous danger literal used at e.g.
    // src/app/login/page.tsx:111.
    info: { bg: theme.primaryMuted, border: theme.primary, fg: theme.accent300 },
    warning: { bg: theme.warningMuted, border: theme.accent700, fg: theme.warning },
    danger: { bg: theme.dangerMuted, border: theme.dangerBorder, fg: theme.danger },
    success: { bg: theme.successMuted, border: theme.primary, fg: theme.accent300 },
  }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      {title ? <Text style={[styles.bannerTitle, { color: palette.fg }]}>{title}</Text> : null}
      <Text style={[styles.bannerBody, { color: palette.fg }]}>{body}</Text>
      {action ? (
        <Pressable onPress={action.onPress}>
          <Text style={[styles.bannerAction, { color: palette.fg }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontSize: 10,
    fontFamily: font.bold,
    // src/app/layout.tsx:166 — letter-spacing: 0.15em, i.e. 1.5px at 10px.
    letterSpacing: 1.5,
    color: theme.subtle,
    marginBottom: 6,
  },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: theme.radiusMd,
    padding: 16,
    ...shadow.sm,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 9, fontFamily: font.bold, letterSpacing: 0.8 },
  distanceStack: { flexDirection: "column" },
  distanceSecondary: { fontFamily: font.regular, color: theme.subtle, fontSize: 11 },
  distanceSecondaryInline: { fontFamily: font.regular, color: theme.subtle, fontSize: 12 },
  /*
   * Primary is OUTLINED, not filled. Nocturne's rule, and on this ground it
   * is also the legible option: the old `onPrimary` (#e9e9ed) on a solid
   * #9184d9 scores 2.5:1 and fails as a label, where accent-300 on the dark
   * ground is 11:1.
   */
  button: {
    backgroundColor: theme.primaryTint,
    borderWidth: 1,
    borderColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: { backgroundColor: theme.primaryMuted, borderColor: theme.accent400 },
  buttonSecondary: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  buttonSecondaryPressed: { backgroundColor: theme.surfaceMuted },
  /* Danger keeps its hue but takes the same outlined shape as everything else. */
  buttonDanger: {
    backgroundColor: theme.dangerMuted,
    borderColor: theme.dangerBorder,
  },
  buttonDangerPressed: { backgroundColor: theme.dangerMuted, borderColor: theme.danger },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontSize: 14, fontFamily: font.semibold, color: theme.accent300 },
  buttonTextSecondary: { color: theme.text },
  buttonTextDanger: { color: theme.danger },
  banner: { borderWidth: 1, borderRadius: theme.radiusSm, padding: 10, marginBottom: 10 },
  bannerTitle: { fontSize: 12, fontFamily: font.bold, marginBottom: 3 },
  bannerBody: { fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  bannerAction: { fontSize: 12, fontFamily: font.bold, marginTop: 6, textDecorationLine: "underline" },
});
