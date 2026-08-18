import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Itinerary from "@/components/Itinerary";
import TripMap from "@/components/TripMap";
import ChatPanel from "@/components/ChatPanel";
import BottomNav, { type MobileTab } from "@/components/BottomNav";
import TripHeader from "@/components/TripHeader";
import { Centered, Spinner } from "@/components/ui";
import { getMe, isAuthError, reportPosition, tripApi, type Me } from "@/lib/api";
import { DeviceLocationProvider, useDeviceLocation } from "@/lib/location";
import { useKeyboardOpen } from "@/lib/useKeyboardOpen";
import { theme } from "@/lib/theme";
import type { LegWithDetails, POI, Trip } from "@/shared/types/trip";
import { font } from "@/lib/typography";

/**
 * Native port of src/app/trips/[tripId]/TripWorkspace.tsx — the mobile branch
 * of it, specifically. The web renders three responsive layouts; a phone only
 * ever gets the single-pane + bottom-nav one, so that's all this screen is.
 */
export default function TripWorkspaceScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[]; replan?: string | string[] }>();
  const tripId = Array.isArray(params.tripId) ? (params.tripId[0] ?? "") : (params.tripId ?? "");
  const replanParam = Array.isArray(params.replan) ? params.replan[0] : params.replan;
  // The off-route email deep link carries this; the web sends `replan=true`,
  // the native link `replan=1`. Accept either rather than silently ignoring one.
  const replanFromOffRoute = replanParam === "1" || replanParam === "true";

  const router = useRouter();
  // Memoized so a re-render doesn't hand loadTrip a fresh object identity and
  // re-fire its effect — that was an infinite /api/trip refetch loop on web.
  const api = useMemo(() => tripApi(tripId), [tripId]);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [legs, setLegs] = useState<LegWithDetails[]>([]);
  const [pois, setPois] = useState<POI[]>([]);
  const [loading, setLoading] = useState(true);
  const [meId, setMeId] = useState<string | null>(null);

  const loadTrip = useCallback(async () => {
    try {
      const [payload, poisData] = await Promise.all([api.getTrip(), api.listPois()]);
      // The trip row IS the payload; legs ride along inside it. Guard on
      // "legs" the way the web does — a malformed body must not blank a trip
      // the user is already looking at.
      if (payload && typeof payload === "object" && "legs" in payload) {
        setTrip(payload);
        setLegs(Array.isArray(payload.legs) ? payload.legs : []);
      }
      if (Array.isArray(poisData)) setPois(poisData);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/sign-in");
        return;
      }
      console.error("Failed to load trip:", err);
    } finally {
      setLoading(false);
    }
  }, [api, router]);

  useEffect(() => {
    void loadTrip();
  }, [loadTrip]);

  // The web knows the viewer's id server-side; native has to ask. Until it
  // answers we fall back to `is_template`, which is the only way a non-owner
  // can reach this screen at all (the web 404s every other stranger) — so the
  // fallback is already correct for both cases that matter.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setMeId((me as Me & { id?: string | null }).id ?? null);
      })
      .catch((err) => {
        if (isAuthError(err)) router.replace("/sign-in");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Fuel is sourced lazily per day (LegCard's day-open effect), so the only
  // "busy" signal is a leg whose own search is mid-flight. Poll until it lands.
  const fuelBusy = legs.some((l) => l.fuel_status === "computing" || l.fuel_status === "pending");
  useEffect(() => {
    if (!fuelBusy) return;
    const t = setInterval(() => {
      void loadTrip();
    }, 2000);
    return () => clearInterval(t);
  }, [fuelBusy, loadTrip]);

  if (loading) {
    return (
      <View style={styles.screen}>
        <TripHeader />
        <Centered>
          <Spinner size="large" />
          <View style={styles.loadingLabel}>
            <Text style={styles.loadingText}>Loading trip</Text>
            <LoadingDots />
          </View>
        </Centered>
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={styles.screen}>
        <TripHeader />
        <Centered>
          <Text style={styles.notFound}>Trip not found.</Text>
        </Centered>
      </View>
    );
  }

  const readonly = meId ? trip.user_id !== meId : trip.is_template;

  return (
    // The provider owns the app's single location pipeline: the one deliberate
    // prompt and the live watch. Mounted here rather than at the root so a
    // cold start never asks — only opening a trip does. Read-only templates
    // don't prompt at all, matching the web.
    <DeviceLocationProvider promptAllowed={!readonly}>
      <Workspace
        tripId={tripId}
        trip={trip}
        legs={legs}
        pois={pois}
        readonly={readonly}
        fuelBusy={fuelBusy}
        replanFromOffRoute={replanFromOffRoute}
        onTripUpdated={loadTrip}
      />
    </DeviceLocationProvider>
  );
}

interface WorkspaceProps {
  tripId: string;
  trip: Trip;
  legs: LegWithDetails[];
  pois: POI[];
  readonly: boolean;
  fuelBusy: boolean;
  replanFromOffRoute: boolean;
  onTripUpdated: () => void;
}

function Workspace({
  tripId,
  trip,
  legs,
  pois,
  readonly,
  fuelBusy,
  replanFromOffRoute,
  onTripUpdated,
}: WorkspaceProps) {
  const keyboardOpen = useKeyboardOpen();

  // Picked once, at mount, from the trip we already have in hand:
  //  - arriving from the off-route email deep link means the user came here to
  //    replan, i.e. to talk to Penny;
  //  - a trip with no legs yet is a trip the user came here to *plan*, not to
  //    stare at an empty itinerary.
  // A lazy initializer (rather than an effect) gives us the web's "at most once
  // per mount" semantics with no flash of the list tab first.
  const [tab, setTab] = useState<MobileTab>(() =>
    replanFromOffRoute || legs.length === 0 ? "chat" : "list"
  );
  const [thinking, setThinking] = useState(false);
  const [unread, setUnread] = useState(0);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  // Drives "open this in the list view": set when the user taps a leg or stop
  // marker on the map. The nonce makes repeat taps on the same target re-fire
  // Itinerary's expand+scroll effect. stopId is null for a leg tap (open the
  // day) or set for a stop tap (scroll to that stop).
  const [focusTarget, setFocusTarget] = useState<{
    legId: string;
    stopId: string | null;
    nonce: number;
  } | null>(null);

  // ChatPanel's onActivity fires from inside a stream callback, so read the
  // live tab off a ref instead of a closed-over value.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const focusTargetRef = useRef(focusTarget);
  focusTargetRef.current = focusTarget;

  useEffect(() => {
    if (tab === "chat") setUnread(0);
  }, [tab]);

  // Report the driver's position once per workspace mount, on the first fix —
  // whether that arrived immediately (permission already granted) or after the
  // user answered the prompt. Fire-and-forget: denial just means no report.
  const { position } = useDeviceLocation();
  const positionReportedRef = useRef(false);
  useEffect(() => {
    if (readonly || !position || positionReportedRef.current) return;
    positionReportedRef.current = true;
    // TODO(sam): the web reverse-geocodes here so Penny can name the driver's
    // location instead of reciting coordinates. Native should do the same with
    // expo-location's `reverseGeocodeAsync` (no Google dependency needed) in a
    // follow-up; until then the server just gets the coordinates.
    reportPosition(tripId, { lat: position.lat, lng: position.lng, place_name: null }).catch(
      () => {
        // Best-effort — a failed position report must never surface to the user.
      }
    );
  }, [tripId, readonly, position]);

  // Tapping a marker opens that day/stop in the list: select it so the map
  // keeps highlighting the same leg, stamp a fresh nonce, then switch tabs.
  const focusInList = useCallback((legId: string, stopId: string | null) => {
    setSelectedLegId(legId);
    setFocusTarget({ legId, stopId, nonce: Date.now() });
    setTab("list");
  }, []);

  const handleSelectLeg = useCallback((legId: string | null) => {
    setSelectedLegId(legId);
    // The web jumps to the map when a leg is picked from the list. Skip that
    // when the id matches the leg we just focused *from* the map — otherwise
    // Itinerary echoing the selection back would bounce the user straight to
    // the tab they were leaving.
    if (legId && legId !== focusTargetRef.current?.legId) setTab("map");
  }, []);

  const handleChatActivity = useCallback((kind: "thinking" | "response" | "error") => {
    setThinking(kind === "thinking");
    if (kind === "response" || kind === "error") {
      // Only badge what the user can't already see.
      if (tabRef.current !== "chat") setUnread((u) => u + 1);
    }
  }, []);

  return (
    <View style={styles.screen}>
      <TripHeader
        tripName={trip.name}
        vehicleId={trip.vehicle_id ?? null}
        fuelBusy={fuelBusy}
        readonly={readonly}
      />

      {/*
        All three panes stay mounted and are toggled with `display` — never
        conditionally rendered. Remounting would reset each pane's state on
        every tab switch: the map's camera, the itinerary's scroll offset, and
        worst of all ChatPanel's in-flight SSE stream, which would be dropped
        mid-answer. This mirrors why the web toggles `display` on fixed panes
        instead of unmounting them.
      */}
      <View style={styles.panes}>
        <View style={[styles.pane, tab === "map" ? styles.paneVisible : styles.paneHidden]}>
          <TripMap
            trip={trip}
            legs={legs}
            pois={pois}
            selectedLegId={selectedLegId}
            onLegSelect={(id) => focusInList(id, null)}
            onStopSelect={(legId, stopId) => focusInList(legId, stopId)}
          />
        </View>

        {/* Itinerary owns its own scroll container on native, so no wrapper. */}
        <View
          style={[
            styles.pane,
            styles.listPane,
            tab === "list" ? styles.paneVisible : styles.paneHidden,
          ]}
        >
          <Itinerary
            trip={trip}
            legs={legs}
            readonly={readonly}
            focusTarget={focusTarget}
            selectedLegId={selectedLegId}
            onSelectLeg={handleSelectLeg}
            onTripUpdated={onTripUpdated}
          />
        </View>

        <View
          style={[
            styles.pane,
            styles.chatPane,
            tab === "chat" ? styles.paneVisible : styles.paneHidden,
          ]}
        >
          <ChatPanel
            tripId={tripId}
            // Mid-onboarding, ChatPanel swaps its composer for trip-setup
            // questions; it also guards on `!readonly` internally.
            onboardingState={trip.onboarding_state}
            readonly={readonly}
            onTripUpdated={onTripUpdated}
            onActivity={handleChatActivity}
          />
        </View>
      </View>

      {/* Hidden while the soft keyboard is up so the chat composer isn't crowded. */}
      {!keyboardOpen ? (
        <BottomNav
          active={tab}
          onChange={setTab}
          thinking={thinking || fuelBusy}
          unread={unread}
        />
      ) : null}
    </View>
  );
}

/** The web's three staggered `loading-dot` spans, in Animated form. */
function LoadingDots() {
  const dots = [useRef(new Animated.Value(0.2)).current, useRef(new Animated.Value(0.2)).current, useRef(new Animated.Value(0.2)).current];

  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 300, easing: Easing.ease, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.2, duration: 300, easing: Easing.ease, useNativeDriver: true }),
          Animated.delay(480 - i * 160),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.dots}>
      {dots.map((v, i) => (
        <Animated.Text key={i} style={[styles.loadingText, { opacity: v }]}>
          .
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  panes: { flex: 1, minHeight: 0 },
  pane: { ...StyleSheet.absoluteFillObject },
  paneVisible: { display: "flex" },
  paneHidden: { display: "none" },
  listPane: { backgroundColor: theme.bg },
  chatPane: { backgroundColor: theme.surfaceMuted },
  loadingLabel: { flexDirection: "row", alignItems: "baseline", marginTop: 16 },
  loadingText: {
    fontFamily: font.regular,
    color: theme.muted,
    fontSize: 13,
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  dots: { flexDirection: "row" },
  notFound: { fontFamily: font.regular, color: theme.muted, fontSize: 14 },
});
