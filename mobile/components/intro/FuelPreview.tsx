import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { formatKm, type UnitsPref } from "@/shared/lib/units";
import { forcedStopLine } from "@/shared/lib/forcedStopReason";
import {
  INTRO_FUEL_DAY_INDEX,
  INTRO_LEGS,
  INTRO_RANGE_KM,
  introDriveLeg,
  type IntroDriveLeg,
} from "@/shared/lib/introFixture";
import { navButtonLabel, navButtonStyles } from "@/components/GoogleMapsNavButton";
import { ExternalLinkIcon, FuelIcon } from "@/components/icons";
import { theme } from "@/lib/theme";
import PreviewFrame, { PREVIEW_W } from "./PreviewFrame";
import { AnimatedTimeline, DayCard, DayHeader, dayKicker, driveMeta } from "./DayParts";
import { fitProjector, pathFor, type LatLngPair } from "./project";
import { at, slide, usePreviewClock } from "./timeline";

/**
 * Screen 2 — the map and the gas stops. The whole trip is drawn as the app
 * draws a route (7g/7h: accent → accent-700 with a soft glow), Finn's fuel
 * stops pop onto it, then one day opens — Madrid → Isla Mayor, day 10 — with
 * its timeline drawing START → FUEL → DESTINATION and the "{stop} in Google
 * Maps" button LegCard shows. No MapView: a map tile costs money and needs a
 * network, and this screen runs before sign-in.
 */
const MAP_W = PREVIEW_W - 28;
const MAP_H = 168;
const ROW_H = 40;

export default function FuelPreview({
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
  const drives = INTRO_LEGS.filter((l): l is IntroDriveLeg => l.type === "drive");
  const all = drives.flatMap((l) => l.route) as LatLngPair[];
  const project = fitProjector(all, MAP_W, MAP_H, 14);
  const routePath = pathFor(all, project);
  const stops = drives.flatMap((l) => l.fuel);
  const day = introDriveLeg(INTRO_FUEL_DAY_INDEX);
  const fuel = day.fuel[0];

  const label =
    `A map of the trip with its ${stops.length} fuel stops, planned for a ` +
    `${formatKm(INTRO_RANGE_KM, units)} range. Day ${INTRO_FUEL_DAY_INDEX + 1}, ` +
    `${day.start} to ${day.end}, ${formatKm(day.distanceKm, units)}, stops for fuel at ` +
    `${fuel.name}, ${formatKm(fuel.alongKm, units)} in.`;

  const rows = [
    {
      key: "start",
      progress: at(t, 1500, 220),
      row: {
        kicker: "START",
        name: day.start,
        distanceKm: 0,
        markerColor: theme.borderStrong,
        isFuel: false,
        isEndpoint: true,
        isStop: false,
        forcedLine: null,
        hasLink: true,
      },
    },
    {
      key: "fuel",
      progress: at(t, 1900, 220),
      row: {
        kicker: "FUEL",
        name: fuel.name,
        distanceKm: fuel.alongKm,
        markerColor: theme.primary,
        isFuel: true,
        isEndpoint: false,
        isStop: false,
        forcedLine: forcedStopLine("fuel", fuel.reason ?? null, units),
        hasLink: true,
      },
    },
    {
      key: "destination",
      progress: at(t, 2300, 220),
      row: {
        kicker: "DESTINATION",
        name: day.end,
        distanceKm: day.distanceKm,
        markerColor: theme.primary,
        isFuel: false,
        isEndpoint: true,
        isStop: false,
        forcedLine: null,
        hasLink: true,
      },
    },
  ];

  return (
    <PreviewFrame label={label}>
      <View style={styles.body}>
        <View style={styles.map}>
          <View style={[styles.reveal, { width: MAP_W, height: MAP_H }]}>
            <Animated.View
              style={[
                styles.reveal,
                { width: MAP_W, height: MAP_H, transform: [{ translateX: slide(t, 0, 900, -MAP_W) }] },
              ]}
            >
              <Animated.View style={{ transform: [{ translateX: slide(t, 0, 900, MAP_W) }] }}>
                <Svg width={MAP_W} height={MAP_H}>
                  <Defs>
                    <LinearGradient id="introRoute" x1="0" y1="0" x2="1" y2="1">
                      <Stop offset="0" stopColor={theme.primary} />
                      <Stop offset="1" stopColor={theme.accent700} />
                    </LinearGradient>
                  </Defs>
                  {/* The glow: the same line, wide and faint, underneath. */}
                  <Path d={routePath} stroke={theme.primary} strokeOpacity={0.22} strokeWidth={7} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                  <Path d={routePath} stroke="url(#introRoute)" strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                </Svg>
              </Animated.View>
            </Animated.View>
          </View>
          {stops.map((s, i) => {
            const { x, y } = project([s.lat, s.lng]);
            const isDay = s === fuel;
            return (
              <Animated.View
                key={`${s.name}-${s.alongKm}`}
                style={[
                  styles.pump,
                  isDay && styles.pumpDay,
                  {
                    left: x - 11,
                    top: y - 11,
                    opacity: at(t, 800 + i * 90, 200),
                    transform: [{ scale: slide(t, 800 + i * 90, 200, 0.4, 1) }],
                  },
                ]}
              >
                <FuelIcon color={theme.primary} size={11} />
              </Animated.View>
            );
          })}
        </View>

        <Animated.View style={[styles.cardWrap, { opacity: at(t, 1300, 250) }]}>
          <DayCard>
            <DayHeader
              kicker={dayKicker(startISO, INTRO_FUEL_DAY_INDEX, units)}
              title={`${day.start} → ${day.end}`}
              meta={driveMeta(day.distanceKm, day.driveMinutes, units)}
            />
            <AnimatedTimeline rows={rows} units={units} rowHeight={ROW_H} lineProgress={at(t, 1500, 1000)} />
            <Animated.View
              style={[
                navButtonStyles.navButton,
                navButtonStyles.navButtonNext,
                styles.nav,
                { opacity: at(t, 2700, 250) },
              ]}
            >
              <ExternalLinkIcon color={theme.accent300} />
              <Text style={navButtonStyles.navButtonText}>{navButtonLabel({ label: fuel.name })}</Text>
            </Animated.View>
          </DayCard>
        </Animated.View>
      </View>
    </PreviewFrame>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: 14, gap: 10 },
  map: {
    width: MAP_W,
    height: MAP_H,
    borderRadius: theme.radiusMd,
    backgroundColor: theme.mapChrome,
    borderWidth: 1,
    borderColor: theme.neutral900,
    overflow: "hidden",
  },
  reveal: { overflow: "hidden" },
  // 7h: 22px accent-ringed GasPump circles.
  pump: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.primary,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  pumpDay: { borderWidth: 2, borderColor: theme.accent300 },
  cardWrap: {},
  nav: { marginTop: 6, marginBottom: 6 },
});
