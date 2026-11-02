import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { UnitsPref } from "@/shared/lib/units";
import {
  INTRO_EXAMPLE_MESSAGE,
  INTRO_LEGS,
  introPlanSummary,
  type IntroLeg,
} from "@/shared/lib/introFixture";
import PlanSummaryCard from "@/components/chat/PlanSummaryCard";
import { TypingBubble } from "@/components/chat/Indicators";
import { bubbleStyles } from "@/components/chat/bubbleStyles";
import { bubbleRadius } from "@/components/chat/format";
import { theme } from "@/lib/theme";
import PreviewFrame from "./PreviewFrame";
import { DayHeader, dayKicker, driveMeta } from "./DayParts";
import { fitProjector, pathFor, type LatLngPair } from "./project";
import { at, between, slide, usePreviewClock } from "./timeline";

/**
 * Screen 1 — the message, then the plan. The user's bubble rises in, Penny
 * types, and her plan lands as the real PlanSummaryCard over three day rows,
 * while the trip's route draws beside them. Every number is the real trip in
 * shared/lib/introFixture.ts.
 */
const SOLO = { isFirst: true, isLast: true };
const THUMB = 64;

export default function PlanPreview({
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
  const summary = introPlanSummary(startISO);
  const days = INTRO_LEGS.slice(0, 3);
  const route = INTRO_LEGS.flatMap((l) => (l.type === "drive" ? l.route : [])) as LatLngPair[];
  const project = fitProjector(route, THUMB, THUMB, 4);
  const routePath = pathFor(route, project);

  const label =
    `A chat. The message: "${INTRO_EXAMPLE_MESSAGE}". ` +
    `Penny's plan: ${summary.total_days} days, ${summary.drive_days} driving, ` +
    `from ${summary.depart_name} and back, with the first three days listed.`;

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
            <Text style={bubbleStyles.bubbleText}>{INTRO_EXAMPLE_MESSAGE}</Text>
          </View>
        </Animated.View>

        {/* No avatar beside the bubble: the real transcript has none (Penny's
            face is in the panel's header strip). */}
        <View style={styles.pennyRow}>
          {/* The real typing bubble, mounted only while it can be seen: its
              own loop is not on this preview's clock. */}
          {active && !reducedMotion ? (
            <Animated.View style={[styles.typing, { opacity: between(t, 400, 1050) }]}>
              <TypingBubble />
            </Animated.View>
          ) : null}
          <Animated.View
            style={[
              bubbleStyles.row,
              bubbleStyles.bubble,
              bubbleRadius("assistant", SOLO),
              bubbleStyles.bubbleAssistant,
              styles.planBubble,
              { opacity: at(t, 1200, 250), transform: [{ translateY: slide(t, 1200, 250, 8) }] },
            ]}
          >
            <PlanSummaryCard summary={summary} units={units} />
          </Animated.View>
        </View>

        <View style={styles.daysBlock}>
          <View style={styles.daysCol}>
            {days.map((leg, i) => (
              <Animated.View
                key={i}
                style={{
                  opacity: at(t, 1500 + i * 120, 220),
                  transform: [{ translateY: slide(t, 1500 + i * 120, 220, 6) }],
                }}
              >
                <DayRow leg={leg} index={i} startISO={startISO} units={units} />
              </Animated.View>
            ))}
          </View>
          {/* The route, revealed left to right: the box slides right while its
              content slides left by the same amount, so the drawing stays put
              and only the window over it moves — two transforms, both on the
              native driver. */}
          <View style={styles.thumb}>
            <Animated.View
              style={[
                styles.reveal,
                { transform: [{ translateX: slide(t, 1500, 1100, -THUMB) }] },
              ]}
            >
              <Animated.View style={{ transform: [{ translateX: slide(t, 1500, 1100, THUMB) }] }}>
                <Svg width={THUMB} height={THUMB}>
                  <Path d={routePath} stroke={theme.accent700} strokeWidth={4} strokeOpacity={0.45} fill="none" strokeLinejoin="round" />
                  <Path d={routePath} stroke={theme.primary} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
                </Svg>
              </Animated.View>
            </Animated.View>
          </View>
        </View>
      </View>
    </PreviewFrame>
  );
}

function DayRow({
  leg,
  index,
  startISO,
  units,
}: {
  leg: IntroLeg;
  index: number;
  startISO: string;
  units: UnitsPref;
}) {
  const kicker = dayKicker(startISO, index, units);
  if (leg.type === "rest") {
    return <DayHeader compact base kicker={kicker} title={leg.title} meta={leg.at} />;
  }
  return (
    <DayHeader
      compact
      kicker={kicker}
      title={`${leg.start} → ${leg.end}`}
      meta={driveMeta(leg.distanceKm, leg.driveMinutes, units)}
    />
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: 12 },
  userRow: { alignSelf: "flex-end" },
  pennyRow: { marginTop: 8, alignItems: "flex-start" },
  typing: { position: "absolute", top: -10, left: 0 },
  planBubble: { paddingTop: 2 },
  daysBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
    paddingTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.neutral900,
  },
  daysCol: { flex: 1, minWidth: 0 },
  thumb: { width: THUMB, height: THUMB, overflow: "hidden" },
  reveal: { width: THUMB, height: THUMB, overflow: "hidden" },
});
