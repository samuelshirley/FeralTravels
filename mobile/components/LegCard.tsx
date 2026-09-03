import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { LegWithDetails } from "@/shared/types/trip";
import { STATUS_MAP, type LegStatus } from "@/shared/types/trip";
import { tripApi } from "@/lib/api";
import {
  assertDestinationReachable,
  buildLegDirectionsUrl,
  buildSegmentedNavUrls,
  isStationaryLeg,
  legDirectionsWaypoints,
  orderNavSegments,
} from "@/shared/lib/maps";
import { useNextStop } from "@/shared/lib/useNextStop";
import { useDeviceLocation } from "@/lib/location";
import StopsSection from "@/components/StopsSection";
import { Distance, Spinner, StatusBadge } from "@/components/ui";
import { shadow, theme } from "@/lib/theme";
import { emitPennyPrefill } from "@/lib/pennyPrefill";
import { font } from "@/lib/typography";
import { DisclosureIcon, ExternalLinkIcon, WarningIcon } from "@/components/icons";

/**
 * How long a leg's sourced fuel stops stay fresh before the day-open loader
 * re-checks them. The web imports this from src/lib/fuelCache.ts, which is not
 * part of the shared mirror (it also carries server-side cache plumbing), so the
 * window is restated here. Keep the two in sync — a shorter window here just
 * means extra cache-hit round trips, not extra Places calls.
 */
const FUEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Every one of these opens Google Maps — `buildSegmentedNavUrls` produces an
 * external URL and `Linking` hands the user to another app. The label says
 * which app and the glyph says it leaves; "Route to" implied turn-by-turn
 * inside a product that has never had any.
 */
function navButtonLabel(seg: { label: string; stopType?: string }): string {
  return `${seg.label} in Google Maps`;
}

interface LegCardProps {
  tripId: string;
  leg: LegWithDetails;
  expanded: boolean;
  onToggle: () => void;
  onChanged?: () => void;
  readonly?: boolean;
  /**
   * Computed date string for this leg, e.g. "Wed 28 May" (metric) or
   * "Wed May 28" (imperial). Null when the trip has no confirmed start date
   * — falls back to leg.label or "Day N".
   */
  dateLabel?: string | null;
  /**
   * True while a fuel replan is in flight for the trip. The nav buttons compose
   * their waypoints from the trip's stops, so during a replan the URLs are
   * briefly stale (waypoints from the previous plan). We render a loading
   * affordance so the user knows the links will update shortly.
   */
  isFuelSyncing?: boolean;
  /** Total number of legs in the trip — used in the syncing copy. */
  fuelSyncTotalLegs?: number;
  /** Stop id to briefly highlight after a map marker tap landed here. */
  highlightStopId?: string | null;
  /**
   * True when this leg sits in the collapsed "Behind you" section — a day the
   * driver has already passed (before the progress/calendar cutoff). NOTE: this
   * is cutoff membership, NOT simply date_iso < today — the *current* leg can
   * carry a stale past date after a progress re-anchor yet must still plan fuel.
   * Past days are read-history: we do NOT lazily source fuel for them on open
   * and we suppress the "Planning fuel stops…" spinner, so opening an old day
   * is instant and quiet.
   */
  isPast?: boolean;
  /** The day the driver is on — the only filled dot in the list. */
  isCurrent?: boolean;
  /**
   * Source this leg's fuel on mount, even while the card is collapsed. Set by
   * `Itinerary` for the ONE day the driver is on — see the note there.
   */
  autoSourceFuel?: boolean;
  /** True when this leg is the one currently selected on the map. */
  selected?: boolean;
}

/** Native port of src/components/LegCard.tsx. */
export default function LegCard({
  tripId,
  leg,
  expanded,
  onToggle,
  onChanged,
  readonly = false,
  dateLabel,
  isFuelSyncing = false,
  fuelSyncTotalLegs,
  highlightStopId = null,
  isPast = false,
  isCurrent = false,
  autoSourceFuel = false,
  selected = false,
}: LegCardProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const isRestDay = leg.leg_type === "rest";
  const driveHours = leg.drive_time_minutes ? (leg.drive_time_minutes / 60).toFixed(1) : null;

  /*
   * What is left in the tank once this day is driven. Mirrors
   * src/components/LegCard.tsx — the server figure is pessimistic where an
   * earlier day is unsourced, so a non-negative result here cannot be a false
   * positive. The negative case is deliberately not rendered.
   */
  const tankSpareKm =
    !isRestDay && leg.range_remaining_start_km != null && leg.distance_km != null
      ? leg.range_remaining_start_km - leg.distance_km
      : null;
  const totalCost = leg.costs.find((c) => c.is_total);
  const itemCosts = leg.costs.filter((c) => !c.is_total);

  const selectedRoute = leg.routes.find((r) => r.status === "selected") ?? null;
  const legCoords = {
    start_lat: leg.start_lat,
    start_lng: leg.start_lng,
    end_lat: leg.end_lat,
    end_lng: leg.end_lng,
  };
  const navWaypointCount = legDirectionsWaypoints(leg.stops).length;
  const navSegments = buildSegmentedNavUrls({
    legCoords,
    endName: leg.end_name,
    selectedRoute,
    stops: leg.stops,
    // distance + drive time tell a rest day (nothing to drive to) apart from a
    // day-loop that returns to its own start (which still needs a button home).
    distanceKm: leg.distance_km,
    driveTimeMinutes: leg.drive_time_minutes,
  });
  // Fallback single URL for the syncing state (doesn't need segments)
  const directionsUrl = buildLegDirectionsUrl({ legCoords, selectedRoute, stops: leg.stops });

  // GPS-aware "next stop" — only computed when the card is expanded.
  const legStart =
    leg.start_lat != null && leg.start_lng != null
      ? { lat: leg.start_lat, lng: leg.start_lng }
      : null;
  const { nextStop, allSegments, isNearRoute, gpsStatus } = useNextStop(
    navSegments,
    legStart,
    expanded
  );
  // Only for the "location is off" affordance below — useNextStop reads the
  // same context for position and status.
  const { request: requestLocation, enablePath } = useDeviceLocation();
  /**
   * GPS may re-ORDER the nav buttons. It may never remove one.
   *
   * This used to be `showSmartNav`, which swapped the whole list for a single
   * next-stop button whenever GPS was active and the device was near the route.
   * "Near the route" includes standing at the leg's start — i.e. at home, weeks
   * before departure, for anyone whose trips begin where they live. The card then
   * offered one link to an unselected fuel stop and no way to reach the day's
   * destination at all. See orderNavSegments.
   */
  const promoteNext = gpsStatus === "active" && isNearRoute && nextStop != null;
  const navButtons = useMemo(
    () => orderNavSegments(allSegments, promoteNext ? nextStop : null),
    [allSegments, promoteNext, nextStop]
  );
  // Fails loudly in Expo dev and in tests; logs in production. The destination
  // button is not allowed to go missing again, quietly or otherwise.
  assertDestinationReachable(
    navButtons,
    `leg ${leg.id} (${leg.start_name} → ${leg.end_name})`,
    // Same inputs buildSegmentedNavUrls used to decide whether to emit a
    // destination at all, so the assertion and the builder cannot disagree.
    {
      stationary:
        leg.end_lat != null &&
        leg.end_lng != null &&
        isStationaryLeg({
          legCoords,
          destination: { lat: leg.end_lat, lng: leg.end_lng },
          distanceKm: leg.distance_km,
          driveTimeMinutes: leg.drive_time_minutes,
        }),
    }
  );

  // ── Lazy fuel sourcing on day-open ──────────────────────────────────────
  // Fuel stops are sourced when the user OPENS a day (no eager trip-wide
  // planning — that was the Google Places cost sink). When this card expands,
  // we POST to the leg's lazy fuel endpoint, which is cache-aware: a leg
  // sourced within FUEL_CACHE_TTL_MS is a server-side cache hit (zero Places
  // calls); a never-sourced or stale leg runs the real search. We mirror that
  // freshness check here so we don't even round-trip on a fresh cache.
  const [fuelLoading, setFuelLoading] = useState(false);
  const fuelFetchSigRef = useRef<string | null>(null);

  useEffect(() => {
    // Never source fuel for a past day — that drive is already behind the
    // driver. Skipping here also keeps `fuelLoading` false so no spinner shows.
    if (readonly || isRestDay || isPast) return;
    if (!expanded && !autoSourceFuel) return;
    const updatedAt = leg.fuel_stops_updated_at;
    const fresh = updatedAt ? Date.now() - Date.parse(updatedAt) < FUEL_CACHE_TTL_MS : false;
    const terminalSuccess =
      leg.fuel_status === "ready" || leg.fuel_status === "no_stations_found";
    // Source lazily when never sourced ('none'), a terminal-success cache that
    // has gone stale, OR a prior 'failed'. We auto-retry 'failed' — the Google
    // station/route calls are cheap and cache-guarded, so a retry self-heals
    // legs stranded on a stale/transient error. We still skip
    // 'computing'/'pending' (a search is already in flight); the
    // signature guard below stops duplicate fires within a render session.
    const needsFetch =
      leg.fuel_status === "none" ||
      leg.fuel_status === "failed" ||
      (terminalSuccess && !fresh);
    if (!needsFetch) return;

    // Guard against duplicate fires: the effect re-runs on every trip reload.
    // The signature folds in the fuel state, so once a fetch lands new data the
    // guard naturally allows a future genuinely-new state through.
    const sig = `${leg.id}:${leg.fuel_status}:${updatedAt ?? "none"}`;
    if (fuelFetchSigRef.current === sig) return;
    fuelFetchSigRef.current = sig;

    let cancelled = false;
    setFuelLoading(true);
    api
      .planFuelStops(leg.id)
      .then(() => {
        // Reload the trip so the freshly-sourced stops + new fuel_status render.
        // Safe to call even if this card unmounted — it's a parent reload.
        onChanged?.();
      })
      .catch((e) => {
        // apiFetch already surfaced this via the global error surface (no silent
        // swallow). Clear the guard so the next open can retry.
        fuelFetchSigRef.current = null;
        console.warn("lazy fuel fetch failed", e);
      })
      .finally(() => {
        if (!cancelled) setFuelLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    isRestDay,
    readonly,
    isPast,
    autoSourceFuel,
    leg.id,
    leg.fuel_status,
    leg.fuel_stops_updated_at,
    api,
    onChanged,
  ]);

  // Base-day accent colour — softer green vs driving-day blue. "Base day" is
  // the user-facing name for `leg_type: 'rest'`; see src/components/LegCard.tsx.
  // src/components/LegCard.tsx:195
  const restDayColor = theme.rest;
  const driveColor = leg.color || theme.primary;
  const dotColor = isRestDay ? restDayColor : driveColor;

  // The web rotates the chevron with a CSS transition; Animated is the native
  // equivalent and runs the rotation off the JS thread.
  const chevron = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(chevron, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded, chevron]);
  const chevronRotate = chevron.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "180deg"],
  });

  const openUrl = (url: string) => {
    void Linking.openURL(url);
  };

  return (
    <View
      style={[
        styles.card,
        expanded && (isRestDay ? styles.cardExpandedRest : styles.cardExpanded),
        isRestDay && styles.cardRest,
        selected && styles.cardSelected,
      ]}
    >
      <Pressable onPress={onToggle} style={styles.headerRow}>
        <View
          style={[
            styles.dot,
            {
              // Filled for today, a hollow ring after it. The old dot was
              // filled on every row, so the list had no "you are here".
              backgroundColor: isCurrent ? dotColor : "transparent",
              borderColor: isCurrent ? "transparent" : isRestDay ? restDayColor : theme.borderStrong,
              borderRadius: isRestDay ? 3 : 5,
            },
          ]}
        />
        <View style={styles.headerBody}>
          <View style={styles.titleLine}>
            {isRestDay ? <Text style={[styles.kicker, { color: restDayColor }]}>BASE</Text> : null}
            {dateLabel ? (
              <Text style={[styles.kicker, { color: isRestDay ? restDayColor : theme.subtle }]}>
                {dateLabel.toUpperCase()}
              </Text>
            ) : !isRestDay && leg.label ? (
              <Text style={styles.kicker}>{leg.label}</Text>
            ) : null}
            <Text style={styles.title}>{leg.title}</Text>
          </View>
          <View style={styles.metaLine}>
            {!isRestDay && leg.distance_km ? (
              // Distance's `style` prop is a ViewStyle; wrapping in a Text lets
              // the inline variant inherit the meta type styles instead.
              <Text style={styles.meta}>
                <Distance km={leg.distance_km} layout="inline" />
              </Text>
            ) : null}
            {!isRestDay && driveHours ? <Text style={styles.meta}>{driveHours} hrs</Text> : null}
            {tankSpareKm != null && tankSpareKm >= 0 ? (
              <Text style={styles.meta}>
                <Distance km={Math.round(tankSpareKm)} layout="inline" /> to spare
              </Text>
            ) : null}
            {isRestDay && leg.end_name ? (
              <Text style={[styles.meta, { color: restDayColor }]}>{leg.end_name}</Text>
            ) : null}
          </View>
          {leg.continuity_warning ? (
            <View style={styles.continuityWarning}>
              <WarningIcon color={theme.warning} />
              <Text style={styles.continuityText}>{leg.continuity_warning}</Text>
            </View>
          ) : null}
        </View>
        {expanded ? (
          <StatusBadge status={leg.status} />
        ) : (
          <Text style={styles.statusBare}>
            {STATUS_MAP[leg.status as LegStatus]?.label ?? ""}
          </Text>
        )}
        <Animated.View style={{ transform: [{ rotate: chevronRotate }] }}>
          <DisclosureIcon color={theme.subtle} size={14} />
        </Animated.View>
      </Pressable>

      {expanded && isRestDay ? (
        <View style={styles.expandedBody}>
          {/* Location */}
          <View>
            <Text style={[styles.blockLabel, { color: restDayColor }]}>LOCATION</Text>
            <Text style={styles.blockValue}>{leg.end_name || leg.overnight || "—"}</Text>
          </View>

          {/* Notes */}
          {leg.parsedNotes.length > 0 ? (
            <View style={styles.notesBlock}>
              <Text style={[styles.blockLabel, { color: restDayColor }]}>PLANS & NOTES</Text>
              {leg.parsedNotes.map((note: string, i: number) => (
                <View key={i} style={[styles.note, { borderLeftColor: `${restDayColor}40` }]}>
                  <Text style={styles.noteText}>{note}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Add to this day button — hands Penny the context for this rest day */}
          {!readonly ? (
            <Pressable
              onPress={() =>
                emitPennyPrefill({
                  legId: leg.id,
                  dayTitle: leg.title,
                  location: leg.end_name || leg.overnight || "",
                  dates: leg.dates,
                })
              }
              style={[
                styles.addToDay,
                { backgroundColor: `${restDayColor}12`, borderColor: `${restDayColor}30` },
              ]}
            >
              <Text style={[styles.addToDayText, { color: restDayColor }]}>+ Add to this day</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {expanded && !isRestDay ? (
        <View style={styles.expandedBody}>
          {leg.parsedNotes.length > 0 ? (
            <View style={styles.notesBlock}>
              {leg.parsedNotes.map((note: string, i: number) => (
                <View key={i} style={[styles.note, { borderLeftColor: theme.border }]}>
                  <Text style={styles.noteText}>{note}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {allSegments.length > 0 ? (
            <View style={styles.navBlock}>
              {isFuelSyncing ? (
                /* Syncing state — placeholder while fuel stops refresh. The web
                   puts the explanation in a hover tooltip, which a phone can't
                   show, so it rides along as the accessibility label instead of
                   inventing new visible copy. */
                <Pressable
                  onPress={directionsUrl ? () => openUrl(directionsUrl) : undefined}
                  disabled={!directionsUrl}
                  accessibilityLabel={
                    fuelSyncTotalLegs && fuelSyncTotalLegs > 0
                      ? `Refreshing fuel stops across ${fuelSyncTotalLegs} leg${
                          fuelSyncTotalLegs === 1 ? "" : "s"
                        } — links will update in a moment.`
                      : "Refreshing fuel stops — links will update in a moment."
                  }
                  style={styles.syncingPill}
                >
                  <Spinner />
                  <Text style={styles.syncingText}>Updating route…</Text>
                </Pressable>
              ) : (
                /* ONE list, always.
                   There is deliberately no "collapse to a single button" branch
                   here any more. GPS decides the ORDER (`isNext` floats to the
                   top); it never decides the CONTENTS. Whatever else is on
                   screen, the driver can always see where the day ends. */
                <View style={styles.navList}>
                  {gpsStatus === "pending" ? (
                    <Text style={styles.navListLabel}>FINDING YOUR LOCATION…</Text>
                  ) : enablePath !== "none" &&
                    (gpsStatus === "denied" || gpsStatus === "unavailable") ? (
                    /* Without a way back, "Not now" in LocationPrimer is a
                       one-way door — nothing else in the app can re-enable
                       location. enablePath picks the branch that actually does
                       something, and its "none" case keeps the control off
                       read-only template trips, which never prompt. */
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        if (enablePath === "settings") void Linking.openSettings();
                        else void requestLocation();
                      }}
                    >
                      <Text style={[styles.navListLabel, styles.navListLabelAction]}>
                        {enablePath === "settings"
                          ? "LOCATION OFF — OPEN SETTINGS"
                          : "LOCATION OFF — TAP TO TURN ON"}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.navListLabel}>
                      {`NAVIGATE (${navButtons.length} STOP${navButtons.length === 1 ? "" : "S"})`}
                    </Text>
                  )}
                  {navButtons.map((seg, i) => (
                    <Pressable
                      key={`${seg.stopType ?? "stop"}-${seg.url}`}
                      onPress={() => openUrl(seg.url)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        seg.isNext ? `${navButtonLabel(seg)} — next stop` : navButtonLabel(seg)
                      }
                      testID={seg.isNext ? "nav-stop-link-next" : "nav-stop-link"}
                      style={[
                        styles.navButton,
                        seg.isNext && styles.navButtonNext,
                        !seg.isNext && i > 0 && navButtons[0].isNext && styles.navButtonSecondary,
                      ]}
                    >
                      <ExternalLinkIcon color={theme.accent300} />
                      <Text style={styles.navButtonText}>{navButtonLabel(seg)}</Text>
                      {seg.isNext ? <Text style={styles.navNextChip}>NEXT</Text> : null}
                    </Pressable>
                  ))}
                </View>
              )}
              {driveHours ? (
                <Text style={styles.caveat}>
                  {navWaypointCount > 0
                    ? `Shown driving time (~${driveHours} h) is the leg headline start→destination only — it excludes detours via added stops.`
                    : `Shown driving time (~${driveHours} h) assumes start→destination without intermediate stops inside this leg card.`}
                </Text>
              ) : null}
            </View>
          ) : null}

          <StopsSection
            tripId={tripId}
            legId={leg.id}
            initialStops={leg.stops}
            fuelStatus={leg.fuel_status}
            fuelPlanError={leg.fuel_plan_error}
            fuelLoading={fuelLoading}
            isPast={isPast}
            onChanged={onChanged}
            readonly={readonly}
            highlightStopId={highlightStopId}
          />

          {itemCosts.length > 0 ? (
            <View style={styles.costsBlock}>
              <Text style={styles.costsTitle}>ESTIMATED COSTS</Text>
              {itemCosts.map((c, i) => (
                <View key={i} style={styles.costRow}>
                  <Text style={styles.costItem}>{c.item}</Text>
                  <Text style={styles.costEstimate}>{c.estimate}</Text>
                </View>
              ))}
              {totalCost ? (
                <View style={styles.costTotalRow}>
                  <Text style={styles.costTotalText}>{totalCost.item}</Text>
                  <Text style={styles.costTotalText}>{totalCost.estimate}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /*
   * Collapsed a day is a ROW — a hairline under it and nothing else, so a
   * week of driving reads as one plan rather than seven boxes. Expanded it
   * becomes the card you are working in. Mirrors src/components/LegCard.tsx.
   */
  card: {
    marginBottom: 0,
    borderRadius: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.neutral900,
    overflow: "hidden",
  },
  cardExpanded: {
    marginBottom: 10,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusLg,
    borderBottomWidth: 0,
    ...shadow.sm,
  },
  cardExpandedRest: { backgroundColor: theme.surface },
  cardRest: { borderLeftWidth: 3, borderLeftColor: theme.rest },
  // The web has no selected state (the desktop list is always beside the map);
  // on a phone the list and map are separate tabs, so the leg the map is
  // highlighting gets a matching tint here.
  cardSelected: { backgroundColor: theme.primaryMuted },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  dot: { width: 10, height: 10, borderWidth: 1, borderColor: "transparent" },
  headerBody: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  kicker: { fontSize: 10, fontFamily: font.semibold, letterSpacing: 1, color: theme.subtle },
  title: { fontSize: 16, fontFamily: font.medium, color: theme.text },
  statusBare: {
    fontSize: 9,
    fontFamily: font.semibold,
    letterSpacing: 0.8,
    color: theme.accent400,
  },
  metaLine: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 3 },
  meta: { fontFamily: font.regular, fontSize: 12, color: theme.subtle },
  continuityWarning: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
    // src/components/LegCard.tsx:310
    backgroundColor: "rgba(217, 119, 6, 0.12)",
    borderWidth: 1,
    // src/components/LegCard.tsx:311
    borderColor: "rgba(217, 119, 6, 0.35)",
  },
  // src/components/LegCard.tsx:317
  continuityIcon: { fontFamily: font.regular, color: "#d97706", fontSize: 12 },
  continuityText: { fontFamily: font.regular, flex: 1, fontSize: 12, lineHeight: 17, color: theme.text },
  chevron: { fontFamily: font.regular, color: theme.subtle, fontSize: 18 },
  expandedBody: { paddingRight: 16, paddingBottom: 16, paddingLeft: 40 },
  blockLabel: { fontSize: 10, fontFamily: font.bold, letterSpacing: 0.8, marginBottom: 2 },
  blockValue: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  notesBlock: { marginTop: 8 },
  note: { borderLeftWidth: 2, paddingVertical: 3, paddingLeft: 12, marginBottom: 2 },
  noteText: { fontFamily: font.regular, fontSize: 13, color: theme.muted, lineHeight: 19 },
  addToDay: {
    marginTop: 14,
    alignSelf: "flex-start",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
  },
  addToDayText: { fontSize: 12, fontFamily: font.semibold, letterSpacing: 0.5 },
  navBlock: { marginTop: 10 },
  syncingPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.borderStrong,
    backgroundColor: theme.surfaceMuted,
  },
  syncingText: { fontSize: 12, fontFamily: font.semibold, letterSpacing: 0.5, color: theme.muted },
  navList: { gap: 4 },
  navListLabelAction: { color: theme.primary, textDecorationLine: "underline" },
  navListLabel: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 0.8,
    color: theme.subtle,
    marginBottom: 2,
  },
  navButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: theme.primary,
  },
  navButtonText: { fontSize: 12, fontFamily: font.semibold, letterSpacing: 0.5, color: theme.onPrimary },
  /** The GPS-promoted button. Sits first and reads a shade heavier. */
  navButtonNext: { paddingVertical: 9 },
  /** Everything after a promoted button — still fully tappable, just quieter. */
  navButtonSecondary: { opacity: 0.82 },
  navNextChip: {
    fontSize: 9,
    fontFamily: font.extrabold,
    letterSpacing: 1,
    color: theme.onPrimary,
    backgroundColor: "rgba(0,0,0,0.18)",
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
  caveat: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, marginTop: 8, maxWidth: 460, lineHeight: 16 },
  costsBlock: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  costsTitle: {
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 0.8,
    color: theme.subtle,
    marginBottom: 6,
  },
  costRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2, gap: 12 },
  costItem: { fontFamily: font.regular, flex: 1, fontSize: 13, color: theme.muted },
  costEstimate: { fontFamily: font.regular, fontSize: 13, color: theme.text },
  costTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    gap: 12,
  },
  costTotalText: { fontSize: 14, fontFamily: font.bold, color: theme.text },
});
