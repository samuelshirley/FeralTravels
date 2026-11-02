import { Animated, StyleSheet, Text, View } from "react-native";
import type { UnitsPref } from "@/shared/lib/units";
import { forcedStopLine } from "@/shared/lib/forcedStopReason";
import { INTRO_ADDED_STOP, introDriveLeg } from "@/shared/lib/introFixture";
import { bubbleStyles } from "@/components/chat/bubbleStyles";
import { bubbleRadius } from "@/components/chat/format";
import { PlaceIcon } from "@/components/icons";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import PreviewFrame from "./PreviewFrame";
import { AnimatedTimeline, DayCard, DayHeader, dayKicker, driveMeta, type AnimatedRow } from "./DayParts";
import { at, pulse, slide, usePreviewClock } from "./timeline";

/**
 * Screen 3 — a Google Maps link pasted into an EXISTING trip's chat. Pasting
 * a link is how a place becomes a stop (Nocturne §7b removed it as a way to
 * START a trip, and §7g removed the day card's paste box), so the preview is
 * a chat with a plan already in it.
 *
 * The message says "on the way" on purpose: Penny's pasted-place rule
 * (src/lib/claude.ts, <pasted_place_disambiguation>) asks "a stop along the
 * way, or where you end the day?" unless the user said which. With it she
 * adds the stop and says in one sentence what changed — which is all her
 * bubble here claims. The new row pulses the way a map-tapped stop is ringed
 * (StopsSection's highlight). The fuel row does not move: re-settling fuel
 * around an added stop is not something this preview may promise.
 */
const SOLO = { isFirst: true, isLast: true };
const ROW_H = 38;
const LINK_TEXT = "maps.app.goo.gl/…";

export function mapsLinkMessage(dayNumber: number): string {
  return `Add this as a stop on the way on day ${dayNumber}`;
}

export function pennyAddedReply(name: string, dayNumber: number): string {
  return `Added ${name} as a stop on day ${dayNumber}.`;
}

export default function MapsLinkPreview({
  active,
  reducedMotion,
  units,
  startISO,
}: {
  active: boolean;
  reducedMotion: boolean;
  units: UnitsPref;
  startISO: string;
}) {
  const t = usePreviewClock(active, reducedMotion);
  const dayIndex = INTRO_ADDED_STOP.dayIndex;
  const dayNumber = dayIndex + 1;
  const day = introDriveLeg(dayIndex);
  const fuel = day.fuel[0];
  const message = mapsLinkMessage(dayNumber);
  const reply = pennyAddedReply(INTRO_ADDED_STOP.name, dayNumber);

  const label =
    `A chat in an existing trip. The message: a Google Maps link and "${message}". ` +
    `Penny: "${reply}" Day ${dayNumber}, ${day.start} to ${day.end}, now lists ` +
    `${INTRO_ADDED_STOP.name} between its fuel stop and its destination.`;

  const rows: AnimatedRow[] = [
    {
      key: "start",
      progress: at(t, 0, 1),
      row: { kicker: "START", name: day.start, distanceKm: 0, markerColor: theme.borderStrong, isFuel: false, isEndpoint: true, isStop: false, forcedLine: null, hasLink: true },
    },
    {
      key: "fuel",
      progress: at(t, 0, 1),
      row: { kicker: "FUEL", name: fuel.name, distanceKm: fuel.alongKm, markerColor: theme.primary, isFuel: true, isEndpoint: false, isStop: false, forcedLine: forcedStopLine("fuel", fuel.reason ?? null, units), hasLink: true },
    },
    {
      key: "stop",
      progress: at(t, 2000, 300),
      highlight: pulse(t, 2200),
      row: { kicker: "STOP", name: INTRO_ADDED_STOP.name, distanceKm: INTRO_ADDED_STOP.alongKm, markerColor: theme.muted, isFuel: false, isEndpoint: false, isStop: true, forcedLine: null, hasLink: true },
    },
    {
      key: "destination",
      progress: at(t, 0, 1),
      row: { kicker: "DESTINATION", name: day.end, distanceKm: day.distanceKm, markerColor: theme.primary, isFuel: false, isEndpoint: true, isStop: false, forcedLine: null, hasLink: true },
    },
  ];

  return (
    <PreviewFrame label={label}>
      <View style={styles.body}>
        <Animated.View
          style={[
            bubbleStyles.row,
            styles.userRow,
            { opacity: at(t, 0, 250), transform: [{ translateY: slide(t, 0, 250, 14) }] },
          ]}
        >
          <View style={[bubbleStyles.bubble, bubbleRadius("user", SOLO), bubbleStyles.bubbleUser]}>
            <View style={styles.linkChip}>
              <PlaceIcon color={theme.accent300} size={13} />
              <Text style={styles.linkText}>{LINK_TEXT}</Text>
            </View>
            <Text style={bubbleStyles.bubbleText}>{message}</Text>
          </View>
        </Animated.View>

        <Animated.View
          style={[
            styles.pennyRow,
            { opacity: at(t, 1100, 250), transform: [{ translateY: slide(t, 1100, 250, 8) }] },
          ]}
        >
          <View style={[bubbleStyles.row, bubbleStyles.bubble, bubbleRadius("assistant", SOLO), bubbleStyles.bubbleAssistant]}>
            <Text style={bubbleStyles.bubbleText}>{reply}</Text>
          </View>
        </Animated.View>

        <View style={styles.cardWrap}>
          <DayCard>
            <DayHeader
              kicker={dayKicker(startISO, dayIndex, units)}
              title={`${day.start} → ${day.end}`}
              meta={driveMeta(day.distanceKm, day.driveMinutes, units)}
            />
            <StopInsert t={t} rows={rows} units={units} />
          </DayCard>
        </View>
      </View>
    </PreviewFrame>
  );
}

/**
 * The timeline with the new STOP row opening a gap for itself: the rows
 * below it slide down by one row as it fades in. Before that, the day reads
 * as it did — START, FUEL, DESTINATION — with the connector already drawn.
 */
function StopInsert({ t, rows, units }: { t: Animated.Value; rows: AnimatedRow[]; units: UnitsPref }) {
  const open = at(t, 1800, 300);
  const shift = open.interpolate({ inputRange: [0, 1], outputRange: [-ROW_H, 0] });
  const above = rows.slice(0, 2);
  const inserted = rows[2];
  const below = rows.slice(3);
  return (
    <View style={{ height: ROW_H * 4 }}>
      {/* FUEL → (STOP →) DESTINATION. Drawn first so the opaque markers sit
          on top of it, and moved with the rows below the gap: it always ends
          at the destination's ring. */}
      <Animated.View
        style={[styles.connector, { top: ROW_H * 1.5, height: ROW_H * 2, transform: [{ translateY: shift }] }]}
      />
      <AnimatedTimeline rows={above} units={units} rowHeight={ROW_H} lineProgress={at(t, 0, 1)} />
      <Animated.View style={{ transform: [{ translateY: shift }] }}>
        <AnimatedTimeline rows={[inserted]} units={units} rowHeight={ROW_H} lineProgress={at(t, 0, 1)} />
        <AnimatedTimeline rows={below} units={units} rowHeight={ROW_H} lineProgress={at(t, 0, 1)} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: 14 },
  userRow: { alignSelf: "flex-end" },
  linkChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginBottom: 6,
    borderRadius: theme.radiusMd,
    borderWidth: 1,
    borderColor: theme.accent700,
    backgroundColor: theme.bg,
  },
  linkText: { fontFamily: font.medium, fontSize: 12.5, color: theme.accent300 },
  pennyRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 8 },
  cardWrap: { marginTop: 14 },
  connector: {
    position: "absolute",
    left: 12,
    width: 2,
    borderRadius: 1,
    backgroundColor: theme.primary,
  },
});
