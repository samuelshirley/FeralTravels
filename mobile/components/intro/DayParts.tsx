import type { ReactNode } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { formatKm, type UnitsPref } from "@/shared/lib/units";
import { formatDate, parseISODate } from "@/shared/lib/dates";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import {
  RouteTimelineRowBody,
  timelineStyles,
  type RouteTimelineRowData,
} from "@/components/RouteTimelineRow";

/**
 * The day pieces the intro draws: a collapsed day row (the itinerary's 7f
 * row) and an expanded day card whose timeline is the REAL row component
 * (RouteTimelineRow, shared with StopsSection). The header type values are
 * LegCard's: 10/semibold kicker, 16/medium title, 12 subtle meta.
 *
 * Presentation only — no data loading, no links, no presses. Every distance
 * goes through formatKm with the units passed in.
 */

export function dayKicker(startISO: string, index: number, units: UnitsPref): string {
  const d = parseISODate(startISO);
  d.setDate(d.getDate() + index);
  return formatDate(d, units).toUpperCase();
}

export function DayHeader({
  kicker,
  base,
  title,
  meta,
  current,
  compact,
}: {
  kicker: string;
  base?: boolean;
  title: string;
  meta: string;
  /** The filled dot; later days get a hollow ring (7f). */
  current?: boolean;
  /** Kicker and meta share a line: the collapsed list on a small preview. */
  compact?: boolean;
}) {
  const color = base ? theme.rest : theme.primary;
  return (
    <View style={[styles.headerRow, compact ? styles.headerRowCompact : null]}>
      <View
        style={[
          styles.dot,
          {
            backgroundColor: current ? color : "transparent",
            borderColor: current ? "transparent" : base ? theme.rest : theme.borderStrong,
          },
        ]}
      />
      <View style={styles.headerBody}>
        <View style={styles.titleLine}>
          {base ? <Text style={[styles.kicker, { color: theme.rest }]}>BASE</Text> : null}
          <Text style={[styles.kicker, base ? { color: theme.rest } : null]}>{kicker}</Text>
          {compact ? (
            <Text style={[styles.meta, styles.metaInline, base ? { color: theme.rest } : null]} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {compact ? null : (
          <Text style={[styles.meta, base ? { color: theme.rest } : null]} numberOfLines={1}>
            {meta}
          </Text>
        )}
      </View>
    </View>
  );
}

/** "564 km · 5.5 hrs" — LegCard's meta line, in the intro's units. */
export function driveMeta(distanceKm: number, driveMinutes: number, units: UnitsPref): string {
  return `${formatKm(distanceKm, units)} · ${(driveMinutes / 60).toFixed(1)} hrs`;
}

export interface AnimatedRow {
  key: string;
  row: RouteTimelineRowData;
  /** 0 → 1 as the row lands. */
  progress: Animated.AnimatedInterpolation<number>;
  /** Optional highlight ring opacity (the third screen's new stop). */
  highlight?: Animated.AnimatedInterpolation<number>;
}

/**
 * The route timeline with each row fading and rising into place, and the
 * connector growing down from START as `lineProgress` goes 0 → 1.
 */
export function AnimatedTimeline({
  rows,
  units,
  lineProgress,
  rowHeight,
}: {
  rows: AnimatedRow[];
  units: UnitsPref;
  lineProgress: Animated.AnimatedInterpolation<number>;
  /** Fixed row height, so the connector's length is known without measuring. */
  rowHeight: number;
}) {
  const lineLen = rowHeight * (rows.length - 1);
  return (
    <View style={timelineStyles.timeline}>
      {rows.length > 1 ? (
        <Animated.View
          style={[
            styles.line,
            {
              top: rowHeight / 2,
              height: lineLen,
              // Grow from the top: scale about the centre, then shift up by
              // the part not yet drawn.
              transform: [
                {
                  translateY: lineProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-lineLen / 2, 0],
                  }),
                },
                { scaleY: lineProgress },
              ],
            },
          ]}
        />
      ) : null}
      {rows.map(({ key, row, progress, highlight }) => (
        <Animated.View
          key={key}
          style={[
            timelineStyles.timelineRow,
            styles.row,
            { height: rowHeight },
            {
              opacity: progress,
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
              ],
            },
          ]}
        >
          {highlight ? (
            <Animated.View pointerEvents="none" style={[styles.highlight, { opacity: highlight }]} />
          ) : null}
          <RouteTimelineRowBody row={row} units={units} />
        </Animated.View>
      ))}
    </View>
  );
}

export function DayCard({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  // LegCard: headerRow / dot / kicker / title / meta.
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  headerRowCompact: { paddingVertical: 5 },
  dot: { width: 10, height: 10, borderWidth: 1, borderRadius: 5 },
  headerBody: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  kicker: { fontSize: 10, fontFamily: font.semibold, letterSpacing: 1, color: theme.subtle },
  title: { fontSize: 16, fontFamily: font.medium, color: theme.text, marginTop: 1 },
  metaInline: { marginTop: 0, flexShrink: 1, fontSize: 11 },
  meta: { fontFamily: font.regular, fontSize: 12, color: theme.subtle, marginTop: 2, fontVariant: ["tabular-nums"] },
  // LegCard's expanded card: surface, 14 radius, an edge.
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radiusLg,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  line: { ...timelineStyles.timelineLine, top: undefined, bottom: undefined },
  row: { paddingVertical: 0 },
  // StopsSection's stopRowHighlighted: a gold (accent, in Nocturne's mono
  // palette) outline on the row.
  highlight: {
    ...StyleSheet.absoluteFillObject,
    left: -6,
    right: -6,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.gold,
  },
});
