import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { StopType } from "@/shared/types/trip";
import { buildMapsSearchUrl } from "@/shared/lib/maps";
import { Spinner } from "@/components/ui";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import { FuelIcon, PlaceIcon } from "@/components/icons";

export interface StopCardProps {
  stopType: StopType;
  name: string;
  distanceFromStartKm: number | null;
  /** Direct Google Maps URI for this place (preferred). */
  googleMapsUri?: string | null;
  /** Fallback coordinates when no googleMapsUri is available. */
  lat?: number | null;
  lng?: number | null;
  /** When true, dims the card and shows a spinner overlay. */
  loading?: boolean;
}

/**
 * Display labels + colors for each stop type in the redesigned UI.
 * Separate from the old TYPE_META (which used emoji icons).
 */
const STOP_DISPLAY: Record<
  StopType,
  { label: string; color: string; Icon: typeof FuelIcon }
> = {
  fuel: {
    label: "FUEL",
    color: theme.gold,
    Icon: FuelIcon,
  },
  other: {
    label: "STOP",
    color: theme.muted,
    Icon: PlaceIcon,
  },
};

/**
 * Native port of src/components/stops/StopCard.tsx.
 *
 * Layout (Option B): icon + type/name/distance. The entire card is tappable and
 * opens Google Maps (the app, when installed — `Linking.openURL` on a
 * maps.google.com URL universal-links into it on iOS and hits the intent filter
 * on Android, which is exactly what the web's `target="_blank"` anchor did).
 */
export default function StopCard({
  stopType,
  name,
  distanceFromStartKm,
  googleMapsUri,
  lat,
  lng,
  loading = false,
}: StopCardProps) {
  const display = STOP_DISPLAY[stopType] ?? STOP_DISPLAY.other;

  // The shared helper takes a search query, which the web's flat
  // `?api=1&query=lat,lng` form folds into the coordinate pair itself — so pass
  // the pair as the query to land on the same point with the same result.
  const href =
    googleMapsUri ??
    (lat != null && lng != null ? buildMapsSearchUrl(lat, lng, `${lat},${lng}`) : null);

  const body = (
    <View style={styles.row}>
      <View style={[styles.icon, { borderColor: display.color }]}>
        <display.Icon color={display.color} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.type, { color: display.color }]}>{display.label}</Text>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {distanceFromStartKm != null ? (
          <Text style={styles.distance}>
            {Math.round(distanceFromStartKm)} km from start
          </Text>
        ) : null}
      </View>
      {href ? <Text style={styles.openGlyph}>↗</Text> : null}
    </View>
  );

  return (
    <Pressable
      onPress={href ? () => void Linking.openURL(href) : undefined}
      disabled={!href || loading}
      style={[styles.card, loading && styles.cardLoading]}
      accessibilityRole={href ? "link" : undefined}
    >
      {body}
      {loading ? (
        <View style={styles.loadingOverlay}>
          <Spinner />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    marginBottom: 6,
  },
  cardLoading: { opacity: 0.6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  /*
   * A ring on the route line, not a tile. The old 32px filled square read as
   * a button — it is a marker, and the same marker the map draws.
   */
  icon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: { fontFamily: font.regular, fontSize: 16 },
  text: { flex: 1, minWidth: 0 },
  type: { fontSize: 10, fontFamily: font.semibold, letterSpacing: 0.8 },
  name: { fontSize: 13.5, fontFamily: font.medium, color: theme.text },
  distance: {
    fontFamily: font.regular,
    fontSize: 10.5,
    color: theme.subtle,
    fontVariant: ["tabular-nums"],
    marginTop: 1,
  },
  openGlyph: { fontFamily: font.regular, fontSize: 14, color: theme.subtle },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    // TODO(sam): src/components/stops/StopCard.tsx:145 writes
    // `rgba(var(--tp-surface-rgb, 30,30,30), 0.6)`, but `--tp-surface-rgb` is
    // never declared in src/app/layout.tsx, so the web actually paints
    // rgba(30, 30, 30, 0.6) — a DARK scrim. Left light here pending a decision
    // on whether the web fallback is the intent or a bug.
    backgroundColor: "rgba(255,255,255,0.6)",
    borderRadius: 8,
  },
});
