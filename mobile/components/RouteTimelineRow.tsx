import { StyleSheet, Text, View } from "react-native";
import { formatKm, type UnitsPref } from "@/shared/lib/units";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import { FuelIcon, NavigateIcon, PlaceIcon } from "@/components/icons";

/**
 * One row of a day's route timeline — START, each stop, DESTINATION — as
 * pure presentation: marker, kicker, name, Finn's forced-stop line, distance,
 * and the drive glyph. No press handling, no data loading.
 *
 * Lifted out of StopsSection unchanged so the first-launch intro draws its
 * day cards with the real row rather than a copy of it. StopsSection still
 * owns the link, the remove control and the highlight; this owns the look.
 */
export interface RouteTimelineRowData {
  kicker: string;
  name: string;
  distanceKm: number | null;
  markerColor: string;
  isFuel: boolean;
  isEndpoint: boolean;
  /** True for a user-added stop (draws a pin). */
  isStop: boolean;
  /** Finn's forced-stop reason, already worded in the user's units. */
  forcedLine: string | null;
  /** Draw the trailing drive glyph (the row opens Google Maps). */
  hasLink: boolean;
}

export function RouteTimelineRowBody({ row, units }: { row: RouteTimelineRowData; units: UnitsPref }) {
  return (
    <>
      <View style={[timelineStyles.marker, { borderColor: row.markerColor }]}>
        {row.isFuel ? (
          <FuelIcon color={row.markerColor} size={12} />
        ) : row.isEndpoint && row.kicker !== "START" ? (
          <PlaceIcon color={row.markerColor} size={12} />
        ) : row.isStop ? (
          <PlaceIcon color={row.markerColor} size={12} />
        ) : null}
      </View>

      <View style={timelineStyles.timelineBody}>
        <Text style={timelineStyles.timelineKicker}>{row.kicker}</Text>
        <Text style={timelineStyles.timelineName} numberOfLines={1}>
          {row.name}
        </Text>
        {row.forcedLine ? <Text style={timelineStyles.timelineForced}>{row.forcedLine}</Text> : null}
      </View>

      <Text style={timelineStyles.timelineDistance}>
        {row.distanceKm != null ? formatKm(row.distanceKm, units) : ""}
      </Text>

      {row.hasLink ? (
        <View style={timelineStyles.timelineNav}>
          <NavigateIcon color={theme.accent300} size={15} />
        </View>
      ) : null}
    </>
  );
}

export const timelineStyles = StyleSheet.create({
  timeline: { position: "relative" },
  /* Inset by half a marker at each end so the line starts and stops INSIDE
     the first and last rings rather than poking out of them. RN has no
     gradient without another dependency, so this is the accent flat — the web
     paints the same line as a gradient. */
  timelineLine: {
    position: "absolute",
    left: 12,
    top: 13,
    bottom: 13,
    width: 2,
    borderRadius: 1,
    backgroundColor: theme.primary,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 7,
  },
  marker: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    // Opaque, so the connector passes behind rather than through.
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  timelineBody: { flex: 1, minWidth: 0 },
  timelineKicker: {
    fontSize: 9.5,
    fontFamily: font.semibold,
    letterSpacing: 1.3,
    color: theme.subtle,
  },
  timelineName: { fontSize: 13.5, fontFamily: font.medium, color: theme.text },
  timelineForced: { fontSize: 10.5, fontFamily: font.regular, color: theme.subtle, marginTop: 1 },
  timelineDistance: {
    fontSize: 10.5,
    fontFamily: font.regular,
    color: theme.subtle,
    fontVariant: ["tabular-nums"],
  },
  timelineNav: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  timelineLink: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 },
});
