import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { FuelStatus, Stop, StopType } from "@/shared/types/trip";
import { classifyFuelPlanError } from "@/shared/lib/fuelPlanErrorSemantics";
import { buildGoHereUrl } from "@/shared/lib/maps";
import { formatKm } from "@/shared/lib/units";
import { useUnits } from "@/lib/units";
import StopCard from "@/components/StopCard";
import { useStopActions } from "@/components/useStopActions";
import { Spinner } from "@/components/ui";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import {
  CloseIcon,
  DisclosureIcon,
  FuelIcon,
  NavigateIcon,
  PlaceIcon,
} from "@/components/icons";

interface StopsSectionProps {
  tripId: string;
  legId: string;
  legStartName: string | null;
  legEndName: string | null;
  legStartCoords?: { lat: number | null; lng: number | null };
  legEndCoords?: { lat: number | null; lng: number | null };
  /** Leg driving distance, for the DESTINATION row's marker. */
  legDistanceKm?: number | null;
  initialStops: Stop[];
  fuelStatus?: FuelStatus;
  fuelPlanError?: string | null;
  /**
   * True while the day-open lazy fuel search is in flight client-side. The
   * server flips fuel_status to 'computing', but the client won't see that
   * until the trip reloads — this drives the "Planning fuel stops…" spinner
   * immediately on open. See LegCard's lazy-fuel effect.
   */
  fuelLoading?: boolean;
  /**
   * True when the owning leg is a past day. Past days are read-history: we
   * suppress the "Planning fuel stops…" spinner entirely (LegCard also skips
   * the lazy fetch), so opening an old day never shows fuel planning running.
   */
  isPast?: boolean;
  onChanged?: () => void;
  readonly?: boolean;
  /**
   * Stop id to briefly ring after a map marker tap scrolled here. The matching
   * card gets a highlight outline. Null = nothing highlighted.
   */
  highlightStopId?: string | null;
}

const TYPE_ORDER: StopType[] = ["fuel", "other"];

/**
 * Native port of src/components/StopsSection.tsx.
 *
 * The leg's own endpoints ARE part of this port now: they are the first and
 * last rows of the route timeline. The web had been passed them and `void`ed
 * all three for so long that this file's header called them leftovers.
 */
export default function StopsSection({
  tripId,
  legId,
  legStartName,
  legEndName,
  legStartCoords,
  legEndCoords,
  legDistanceKm,
  initialStops,
  fuelStatus = "none",
  fuelPlanError = null,
  fuelLoading = false,
  isPast = false,
  onChanged,
  readonly = false,
  highlightStopId = null,
}: StopsSectionProps) {
  const router = useRouter();
  const { units } = useUnits();
  const {
    activeStops,
    dismissedStops,
    syncInitialStops,
    remove,
  } = useStopActions({ tripId, legId, initialStops, onChanged });

  useEffect(() => {
    syncInitialStops(initialStops);
  }, [initialStops, syncInitialStops]);

  // The web's <details> element; RN has no disclosure primitive so the open
  // state is explicit.
  const [showDismissed, setShowDismissed] = useState(false);

  // --- Fuel planning UI state ---
  // `fuelLoading` reflects the client-initiated day-open search before the
  // trip reload surfaces the server's 'computing' status.
  // A past day never shows fuel planning as running — even if the leg was left
  // in a stale 'computing'/'pending' state, we don't re-plan history.
  const fuelPlanning =
    !isPast && (fuelLoading || fuelStatus === "computing" || fuelStatus === "pending");
  const fuelErrorCategory = classifyFuelPlanError(fuelPlanError);

  // --- Sort stops for display: by distance from start, then type ---
  const sortedStops = useMemo(() => {
    return [...activeStops].sort((a, b) => {
      const distA = a.distance_from_start_km ?? Infinity;
      const distB = b.distance_from_start_km ?? Infinity;
      if (distA !== distB) return distA - distB;
      return TYPE_ORDER.indexOf(a.stop_type) - TYPE_ORDER.indexOf(b.stop_type);
    });
  }, [activeStops]);

  /*
   * The timeline's rows: the leg's own START, every active stop in route
   * order, and its DESTINATION. The endpoints are rows rather than headings
   * because they are places on the same line — "Reims Ids · 147 km" needs a
   * FROM, and it used to be nowhere on the screen. Mirrors
   * src/components/StopsSection.tsx.
   */
  const timelineRows = useMemo(() => {
    // Directions from wherever the device is, never a dropped pin.
    const mapsHref = buildGoHereUrl;

    type Row = {
      key: string;
      kicker: string;
      name: string;
      distanceKm: number | null;
      markerColor: string;
      isFuel: boolean;
      isEndpoint: boolean;
      href: string | null;
      stop: Stop | null;
    };

    const rows: Row[] = [];

    if (legStartName) {
      rows.push({
        key: "start",
        kicker: "START",
        name: legStartName,
        distanceKm: 0,
        // A hollow neutral ring: you have already been here.
        markerColor: theme.borderStrong,
        isFuel: false,
        isEndpoint: true,
        href: mapsHref(legStartCoords?.lat, legStartCoords?.lng),
        stop: null,
      });
    }

    for (const stop of sortedStops) {
      const fuel = stop.stop_type === "fuel";
      rows.push({
        key: String(stop.id),
        kicker: fuel ? "FUEL" : "STOP",
        name: stop.name,
        distanceKm: stop.distance_from_start_km,
        markerColor: fuel ? theme.primary : theme.muted,
        isFuel: fuel,
        isEndpoint: false,
        href: mapsHref(stop.lat, stop.lng),
        stop,
      });
    }

    if (legEndName) {
      rows.push({
        key: "destination",
        kicker: "DESTINATION",
        name: legEndName,
        distanceKm: legDistanceKm ?? null,
        markerColor: theme.primary,
        isFuel: false,
        isEndpoint: true,
        href: mapsHref(legEndCoords?.lat, legEndCoords?.lng),
        stop: null,
      });
    }

    return rows;
  }, [legStartName, legStartCoords, legEndName, legEndCoords, legDistanceKm, sortedStops]);

  return (
    <>
      {/* STOPS */}
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>STOPS</Text>

        {/* Fuel planning status */}
        {!readonly && fuelPlanning ? (
          <View style={styles.planningRow}>
            <Spinner />
            <Text style={styles.planningText}>Planning fuel stops…</Text>
          </View>
        ) : null}

        {/* Fuel error: vehicle profile.
            Hand-rolled rather than <Banner> because the copy is one flowing
            sentence with a bold lead-in; Banner splits title and body onto
            separate lines. */}
        {!readonly && fuelStatus === "failed" && fuelErrorCategory === "user_vehicle_profile" ? (
          <View style={[styles.notice, styles.noticeInfo]}>
            <Text style={styles.noticeText}>
              <Text style={styles.noticeStrongInfo}>Finish your vehicle profile</Text> so we
              can plan fuel stops along this leg.
              {fuelPlanError ? <Text style={styles.noticeDetail}> {fuelPlanError}</Text> : null}
            </Text>
            <Pressable
              // The web links to /vehicle-setup?returnTo=…; native keeps the
              // vehicle profile inside Settings, and the router restores this
              // screen on back, so no returnTo round-trip is needed.
              onPress={() => router.push("/settings")}
              style={styles.noticeButton}
            >
              <Text style={styles.noticeButtonText}>Open vehicle setup</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Fuel error: platform */}
        {!readonly && fuelStatus === "failed" && fuelErrorCategory !== "user_vehicle_profile" ? (
          <View style={[styles.notice, styles.noticeDanger]}>
            <Text style={[styles.noticeText, styles.noticeTextDanger]}>
              <Text style={styles.noticeStrongDanger}>
                {fuelErrorCategory === "platform_config"
                  ? "Fuel planning paused (Places / Maps setup)."
                  : "Fuel planning failed."}
              </Text>{" "}
              We'll retry automatically the next time you edit a stop or change the route.
              {fuelPlanError ? <Text style={styles.noticeDetail}> {fuelPlanError}</Text> : null}
            </Text>
          </View>
        ) : null}

        {/* No stations found within the widest search radius — a real warning,
            not a failure. Penny couldn't auto-plan a stop because the route is
            genuinely too remote; the user must carry extra fuel or plan a stop
            manually. Shown in readonly too — it's a safety signal. */}
        {fuelStatus === "no_stations_found" ? (
          <View style={[styles.notice, styles.noticeWarning]}>
            <Text style={styles.noticeText}>
              <Text style={styles.noticeStrongWarning}>
                No fuel stations found along this leg.
              </Text>{" "}
              {fuelPlanError ??
                "This stretch is too remote for an auto-planned fuel stop — carry extra fuel or plan a stop manually."}
            </Text>
          </View>
        ) : null}

        {/*
          THE ROUTE TIMELINE. Stops were a stack of cards; they are rows on a
          line now — START, each stop in order, DESTINATION — so a day reads as
          a route rather than an inventory.

          The connector is ONE absolutely-positioned element behind the markers,
          not a segment per row: per-row segments leave a hairline gap at every
          join, and the gaps are what make it look like a list again.
        */}
        <View style={styles.timeline}>
          {timelineRows.length > 1 ? <View style={styles.timelineLine} /> : null}

          {timelineRows.map((row) => {
            const highlighted = row.stop != null && highlightStopId === String(row.stop.id);
            /*
             * THE WHOLE ROW IS THE PRESS TARGET. It used to be a View with a
             * 30pt arrow at the end as the only pressable thing, so the
             * obvious press — the `FUEL / Shell / 390 km` row itself — did
             * nothing. The `×` remove control is a SIBLING of the link, not
             * inside it, so removing a stop can never also start a drive.
             * Mirrors src/components/StopsSection.tsx.
             */
            const rowBody = (
              <>
                <View style={[styles.marker, { borderColor: row.markerColor }]}>
                  {row.isFuel ? (
                    <FuelIcon color={row.markerColor} size={12} />
                  ) : row.isEndpoint && row.kicker !== "START" ? (
                    <PlaceIcon color={row.markerColor} size={12} />
                  ) : row.stop ? (
                    <PlaceIcon color={row.markerColor} size={12} />
                  ) : null}
                </View>

                <View style={styles.timelineBody}>
                  <Text style={styles.timelineKicker}>{row.kicker}</Text>
                  <Text style={styles.timelineName} numberOfLines={1}>
                    {row.name}
                  </Text>
                </View>

                <Text style={styles.timelineDistance}>
                  {row.distanceKm != null ? formatKm(row.distanceKm, units) : ""}
                </Text>

                {row.href ? (
                  <View style={styles.timelineNav}>
                    <NavigateIcon color={theme.accent300} size={15} />
                  </View>
                ) : null}
              </>
            );
            return (
              <View
                key={row.key}
                style={[styles.timelineRow, highlighted && styles.stopRowHighlighted]}
              >
                {row.href ? (
                  <Pressable
                    onPress={() => void Linking.openURL(row.href!)}
                    accessibilityRole="link"
                    accessibilityLabel={`${row.name} in Google Maps`}
                    testID="stop-row-link"
                    style={styles.timelineLink}
                  >
                    {rowBody}
                  </Pressable>
                ) : (
                  <View style={styles.timelineLink}>{rowBody}</View>
                )}

                {row.stop && !readonly ? (
                  <Pressable
                    onPress={() => remove(row.stop!.id)}
                    accessibilityLabel={`Remove ${row.name}`}
                    hitSlop={6}
                    style={styles.removeButton}
                  >
                    <CloseIcon color={theme.subtle} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>

        {sortedStops.length === 0 &&
        !fuelPlanning &&
        fuelStatus !== "failed" &&
        fuelStatus !== "no_stations_found" ? (
          <Text style={styles.emptyText}>
            {fuelStatus === "ready"
              ? // Sourced, and the planner verified nothing is needed — say so
                // instead of the ambiguous "no stops yet" (which reads as
                // "nothing happened"). Only claims what the tank math checked;
                // no promises about when the next fuel stop comes.
                "No fuel stop needed on this day — it fits within the fuel you have left."
              : readonly
                ? "No stops."
                : "No stops yet — fuel stops appear here automatically."}
          </Text>
        ) : null}

        {/* Dismissed stops (collapsed) */}
        {dismissedStops.length > 0 ? (
          <View style={styles.dismissedBlock}>
            <Pressable onPress={() => setShowDismissed((v) => !v)}>
              <Text style={styles.dismissedSummary}>
                <DisclosureIcon color={theme.subtle} /> {dismissedStops.length} DISMISSED
              </Text>
            </Pressable>
            {showDismissed ? (
              <View style={styles.dismissedList}>
                {dismissedStops.map((stop) => (
                  <StopCard
                    key={stop.id}
                    stopType={stop.stop_type}
                    name={stop.name}
                    distanceFromStartKm={stop.distance_from_start_km}
                    lat={stop.lat}
                    lng={stop.lng}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

    </>
  );
}

const styles = StyleSheet.create({
  /*
   * The one structural change in the reskin. This file drew two more cards
   * inside the day card — STOPS and PASTE GPS — with stop rows nested inside
   * those: four levels of border and fill for one day. A section is now a
   * hairline and a kicker. Mirrors src/components/StopsSection.tsx.
   */
  sectionCard: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme.neutral900,
  },
  sectionTitle: {
    fontSize: 9.5,
    fontFamily: font.semibold,
    letterSpacing: 1.3,
    color: theme.subtle,
    marginBottom: 8,
  },
  planningRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  planningText: { fontFamily: font.regular, fontSize: 11, color: theme.muted },
  notice: {
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 5,
    borderWidth: 1,
  },
  // src/components/StopsSection.tsx:141 and the sibling notice branches.
  noticeInfo: { backgroundColor: "rgba(78,122,176,0.08)", borderColor: "rgba(78,122,176,0.28)" },
  noticeDanger: { backgroundColor: "rgba(198,93,74,0.08)", borderColor: "rgba(198,93,74,0.3)" },
  // src/components/StopsSection.tsx:208-209
  noticeWarning: { backgroundColor: "rgba(214,158,46,0.1)", borderColor: "rgba(214,158,46,0.4)" },
  noticeText: { fontFamily: font.regular, fontSize: 11, lineHeight: 17, color: theme.text },
  noticeTextDanger: { color: theme.danger },
  noticeStrongInfo: { fontFamily: font.bold, color: theme.primary },
  noticeStrongDanger: { fontFamily: font.bold, color: theme.danger },
  // src/components/StopsSection.tsx:216 — `var(--tp-warning, #b7791f)`, and
  // --tp-warning is never declared, so the literal is what the web paints.
  noticeStrongWarning: { fontFamily: font.bold, color: "#b7791f" },
  noticeDetail: { color: theme.muted },
  noticeButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: theme.primary,
  },
  noticeButtonText: { fontSize: 11, fontFamily: font.semibold, color: theme.onPrimary },
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
  timelineDistance: {
    fontSize: 10.5,
    fontFamily: font.regular,
    color: theme.subtle,
    fontVariant: ["tabular-nums"],
  },
  timelineNav: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  timelineLink: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8 },
  // The web pulses a box-shadow ring; RN has no inset shadow, so the highlight
  // is a gold outline on the row instead.
  stopRowHighlighted: { borderWidth: 2, borderColor: theme.gold },
  stopRowCard: { flex: 1, minWidth: 0 },
  removeButton: {
    width: 28,
    height: 28,
    marginBottom: 6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
  },
  removeGlyph: { fontFamily: font.regular, fontSize: 16, lineHeight: 18, color: theme.muted },
  emptyText: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, lineHeight: 16 },
  dismissedBlock: { marginTop: 8 },
  dismissedSummary: { fontFamily: font.regular, fontSize: 10, color: theme.muted, letterSpacing: 0.8 },
  dismissedList: { marginTop: 6 },
});
