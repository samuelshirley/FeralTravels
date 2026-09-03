import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Linking,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import MapView, {
  Callout,
  Marker,
  Polyline,
  PROVIDER_GOOGLE,
  type LatLng,
  type MapStyleElement,
  type Region,
} from "react-native-maps";

import { Spinner } from "@/components/ui";
import { tripApi } from "@/lib/api";
import { GOOGLE_MAPS_API_KEY } from "@/lib/config";
import { theme, shadow } from "@/lib/theme";
import { clusterPixels, type PixelPoint } from "@/shared/lib/mapClustering";
import { haversineKm } from "@/shared/lib/polyline";
import { font } from "@/lib/typography";
import type {
  GeoJSONLineString,
  LegWithDetails,
  POI,
  StopType,
  Trip,
} from "@/shared/types/trip";

/**
 * Native mirror of src/components/TripMap.tsx.
 *
 * The web builds imperative google.maps.Marker / Polyline objects and hand-manages
 * their lifecycle in a layers ref. react-native-maps is declarative, so the whole
 * "wipe then re-add" bookkeeping disappears — markers and polylines are just JSX
 * driven by props/state, and React handles the teardown. Everything else (the
 * clustering, the zoom-preserving pan, the colors, the copy) is a faithful port.
 */
interface TripMapProps {
  trip: Trip;
  legs: LegWithDetails[];
  pois: POI[];
  selectedLegId: string | null;
  onLegSelect: (legId: string) => void;
  /**
   * Fired when the user taps a stop marker (fuel or user-added) on the map.
   * The parent opens that stop in the list view (expand owning leg + scroll).
   */
  onStopSelect: (legId: string, stopId: string) => void;
}

/** A stop flattened out of the legs for map rendering. */
interface MapStopPoint {
  legId: string;
  stopId: string;
  lat: number;
  lng: number;
  type: StopType;
  name: string;
  distanceKm: number | null;
}

const STOP_GRID_CELL_PX = 64;
// Marker palette, copied from src/components/TripMap.tsx:
//   :36 :37 :38 (stop/cluster), :297+ (leg stroke fallback = --tp-primary),
//   :426 (last-leg destination), :354 (gap stroke), :452 and :668 (POI/trail).
const FUEL_STOP_COLOR = "#C9912F";
const OTHER_STOP_COLOR = "#7A7A7A";
const CLUSTER_COLOR = "#4A5A6A";
const DEFAULT_LEG_COLOR = "#4E7AB0";
const DESTINATION_COLOR = "#B8956A";
const GAP_COLOR = "#c65d4a";
const POI_COLOR = "#E8D57C";
const TRAIL_FALLBACK_COLOR = "#E8D57C";

/** Web-Mercator tile size — the unit google.maps.Projection works in. */
const WORLD_TILE_PX = 256;

/**
 * How long we wait for the native map to report ready before assuming it never
 * will. There is no onError on MapView: a missing/invalid native SDK key shows a
 * blank grey surface forever rather than raising, so a watchdog is the only way
 * to turn that silent failure into the web's "Map failed to load." state.
 */
const MAP_READY_TIMEOUT_MS = 20000;

const MAP_TIMEOUT_MESSAGE =
  "The map never finished loading. PROVIDER_GOOGLE on iOS needs ios.config.googleMapsApiKey in app.json, and react-native-maps needs a development build — it does not run in Expo Go. See components/README-map.md.";

/**
 * Provider choice. The web product is Google Maps, and react-native-maps defaults
 * to APPLE Maps on iOS, so we ask for Google whenever a key is configured. When
 * no key is set we fall back to the platform default rather than forcing
 * PROVIDER_GOOGLE — an unkeyed Google map renders as a blank grey rectangle,
 * whereas Apple Maps still shows the routes. (Android is always Google Maps
 * regardless of this prop; the constant only changes iOS behaviour.)
 *
 * NOTE FOR SAM: passing PROVIDER_GOOGLE is necessary but NOT sufficient on iOS —
 * the Google Maps iOS SDK also needs its key wired into app.json under
 * `ios.config.googleMapsApiKey` and a rebuilt dev client. That is a native config
 * step this file cannot do. Missing it degrades to a blank map, not a crash.
 */
const MAP_PROVIDER = GOOGLE_MAPS_API_KEY ? PROVIDER_GOOGLE : undefined;

/**
 * Nocturne basemap — INERT ON EVERY SHIPPED BUILD, and kept anyway.
 *
 * `customMapStyle` is honoured only under PROVIDER_GOOGLE, and no
 * EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is set on either eas.json profile, so
 * MAP_PROVIDER is undefined and this app renders Apple Maps. Apple follows
 * `userInterfaceStyle: 'dark'` from app.config.js instead, which is what
 * actually darkens the tiles today.
 *
 * It stays because the cost of deleting it is asymmetric: if a Google key is
 * ever added, an absent style silently reinstates a light map inside a dark
 * app. Mirrors DARK_MAP_STYLE in src/components/TripMap.tsx.
 */
const DARK_MAP_STYLE: MapStyleElement[] = [
  { elementType: "geometry", stylers: [{ color: "#1f2130" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#161826" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#b2b6ca" }] },
  { featureType: "administrative.country", elementType: "geometry.stroke", stylers: [{ color: "#595d6c" }] },
  { featureType: "administrative.province", elementType: "geometry.stroke", stylers: [{ color: "#3f424d" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#e9e9ed" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#292b31" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#75798c" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3f424d" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#595d6c" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#12131f" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#5d5294" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#1b1d2a" }] },
];
/** Where the map sits before we have any coordinates to fit (the web's center/zoom 5). */
const FALLBACK_REGION: Region = {
  latitude: 52,
  longitude: 10,
  latitudeDelta: 20,
  longitudeDelta: 20,
};

// ── GPX response shapes ─────────────────────────────────────────────────────
// `/api/gpx` returns the GPXTrail row PLUS a parsed `geojson` blob and an
// optional per-trail color. GPXTrail in shared/types doesn't model those extra
// fields (the web casts the raw fetch the same way), so we narrow locally.
interface GpxFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry:
      | { type: "LineString"; coordinates: [number, number, number?][] }
      | { type: "MultiLineString"; coordinates: [number, number, number?][][] }
      | { type: "Point"; coordinates: [number, number, number?] };
    properties?: Record<string, unknown>;
  }>;
}

interface GpxTrailResponse {
  id: string;
  name: string;
  geojson: GpxFeatureCollection | null;
  color?: string | null;
  surface?: string | null;
}

/** One decoded GPX line ready to render. */
interface TrailLine {
  key: string;
  color: string;
  coords: LatLng[];
}

/** Flatten every renderable stop (has coords, not dismissed) out of the legs. */
function collectStopPoints(legs: LegWithDetails[]): MapStopPoint[] {
  const out: MapStopPoint[] = [];
  for (const leg of legs) {
    for (const stop of leg.stops) {
      if (stop.status === "dismissed") continue;
      if (stop.lat == null || stop.lng == null) continue;
      out.push({
        legId: leg.id,
        stopId: String(stop.id),
        lat: stop.lat,
        lng: stop.lng,
        type: stop.stop_type,
        name: stop.name,
        distanceKm: stop.distance_from_start_km,
      });
    }
  }
  return out;
}

/**
 * GeoJSON coordinates are `[lng, lat]` — longitude FIRST. react-native-maps wants
 * `{ latitude, longitude }`. Swapping these is the classic bug on this map: the
 * pair still type-checks and still renders, it just puts a Norwegian route in the
 * Indian Ocean. Destructure by name at the single point of conversion so the
 * ordering is stated once and can't drift.
 */
function lineStringToCoords(
  geometry: GeoJSONLineString | null | undefined
): LatLng[] {
  if (!geometry || geometry.coordinates.length === 0) return [];
  return geometry.coordinates.map(([lng, lat]) => ({
    latitude: lat,
    longitude: lng,
  }));
}

/** Same [lng, lat] → { latitude, longitude } swap for GPX feature geometry. */
function gpxLineToCoords(line: [number, number, number?][]): LatLng[] {
  return line.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

/**
 * Apply an alpha to a hex color. react-native-maps polylines have no
 * strokeOpacity (the web's Google Polyline does), so the opacity has to be baked
 * into the stroke color itself.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  let r: number;
  let g: number;
  let b: number;
  if (long) {
    r = parseInt(long[1], 16);
    g = parseInt(long[2], 16);
    b = parseInt(long[3], 16);
  } else if (short) {
    r = parseInt(short[1] + short[1], 16);
    g = parseInt(short[2] + short[2], 16);
    b = parseInt(short[3] + short[3], 16);
  } else {
    // Already rgba()/named — hand it back and let the platform deal with it.
    return color;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Project lat/lng into Google's world coordinate space (0..256 at zoom 0). This
 * is what `google.maps.Projection.fromLatLngToPoint` does on the web; there is no
 * equivalent synchronous API on MapView (only the async, per-point
 * `pointForCoordinate`, which would be one bridge round-trip per stop per pan),
 * so we reimplement the standard Web Mercator formula and keep clustering local.
 */
function worldPoint(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng + 180) / 360) * WORLD_TILE_PX;
  // Clamp near the poles: the Mercator y goes to infinity at ±90°.
  const siny = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const y =
    (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * WORLD_TILE_PX;
  return { x, y };
}

/**
 * Google-style integer-free zoom implied by the visible longitude span and the
 * map's on-screen width. `2^zoom` is the multiplier that turns world coords into
 * pixels, which is exactly the `scale` the web computes from `map.getZoom()`.
 */
function zoomForRegion(region: Region, widthPx: number): number | null {
  if (widthPx <= 0 || region.longitudeDelta <= 0) return null;
  return Math.log2((widthPx * 360) / (WORLD_TILE_PX * region.longitudeDelta));
}

/** Stable identity for a leg's route geometry — refit only when this changes. */
function legRouteKey(leg: LegWithDetails): string {
  return `${leg.id}:${leg.start_lat},${leg.start_lng}->${leg.end_lat},${leg.end_lng}:${
    leg.geometry?.coordinates.length ?? 0
  }`;
}

export default function TripMap({
  trip,
  legs,
  pois,
  selectedLegId,
  onLegSelect,
  onStopSelect,
}: TripMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mapWidth, setMapWidth] = useState(0);
  const [region, setRegion] = useState<Region>(FALLBACK_REGION);
  const [trails, setTrails] = useState<TrailLine[]>([]);
  const [trailsLoading, setTrailsLoading] = useState(false);

  // ── Route geometry ────────────────────────────────────────────────────────
  // The web keeps a routeCacheRef keyed by leg coords because it used to call the
  // Directions service; routes now come straight from the stored DB geometry, so
  // a memo over `legs` is the whole cache.
  const routes = useMemo(
    () =>
      legs.map((leg) => ({
        leg,
        color: leg.color || DEFAULT_LEG_COLOR,
        coords: lineStringToCoords(leg.geometry),
      })),
    [legs]
  );

  /**
   * Gap polylines: dashed red lines between non-contiguous consecutive legs so
   * the user can see where Penny left a hole in the route. The web approximates
   * the gap with `sqrt(dlat² + dlng²) * 111`, which over-reports badly at
   * Nordkapp latitudes (a degree of longitude is ~40km at 71°N, not 111km); the
   * shared haversine is the same math the fuel planner already trusts.
   */
  const gaps = useMemo(() => {
    const out: Array<{ key: string; coords: LatLng[] }> = [];
    for (let i = 0; i < legs.length - 1; i++) {
      const curr = legs[i];
      const next = legs[i + 1];
      if (
        curr.end_lat == null ||
        curr.end_lng == null ||
        next.start_lat == null ||
        next.start_lng == null
      ) {
        continue;
      }
      const km = haversineKm(
        { lat: curr.end_lat, lng: curr.end_lng },
        { lat: next.start_lat, lng: next.start_lng }
      );
      // Only draw if the gap is meaningful (>25km as-the-crow-flies).
      if (km <= 25) continue;
      out.push({
        key: `gap:${curr.id}->${next.id}`,
        coords: [
          { latitude: curr.end_lat, longitude: curr.end_lng },
          { latitude: next.start_lat, longitude: next.start_lng },
        ],
      });
    }
    return out;
  }, [legs]);

  // ── Stop clustering ───────────────────────────────────────────────────────
  // Stops only exist in `legs[].stops` once the owning day has been opened in the
  // list (lazy fuel sourcing — option B). We render whatever is loaded; the map
  // fills in as the user browses days. Clustering is screen-space (see
  // shared/lib/mapClustering) so dense fuel runs collapse into a count bubble
  // when zoomed out and resolve into individual, tappable markers when zoomed in.
  const stopPoints = useMemo(() => collectStopPoints(legs), [legs]);

  /**
   * Recomputed whenever `region` changes, and `region` is only written by
   * onRegionChangeComplete — react-native-maps' equivalent of the Google 'idle'
   * event the web re-clusters on. Both fire once the camera has settled, so the
   * cluster grid tracks zoom/pan without churning during the gesture.
   */
  const stopGroups = useMemo(() => {
    if (stopPoints.length === 0) return [] as MapStopPoint[][];
    const byId = new Map(stopPoints.map((p) => [p.stopId, p]));
    const zoom = zoomForRegion(region, mapWidth);

    // Projection not ready yet (map hasn't laid out) → render everything as
    // individual markers; the next settle will cluster properly. Mirrors the
    // web's projectionReady === false path.
    if (zoom == null) return stopPoints.map((p) => [p]);

    const scale = 2 ** zoom;
    const pixels: PixelPoint[] = stopPoints.map((p) => {
      const world = worldPoint(p.lat, p.lng);
      return { id: p.stopId, x: world.x * scale, y: world.y * scale };
    });

    return clusterPixels(pixels, STOP_GRID_CELL_PX).map((group) =>
      group.ids
        .map((id) => byId.get(id))
        .filter((m): m is MapStopPoint => m != null)
    );
  }, [stopPoints, region, mapWidth]);

  // ── GPX trail overlays ────────────────────────────────────────────────────
  // The web re-fetches on every `trailsVersion` bump (the upload UI increments it
  // after a successful GPX upload). This component's prop signature has no such
  // prop, and native has no GPX upload screen yet, so we fetch once per leg
  // whenever the LEG SET changes — keyed on leg ids, not the whole `legs` array,
  // so unrelated churn (stops loading as days are opened) doesn't refetch.
  const legIdsKey = useMemo(() => legs.map((l) => l.id).join(","), [legs]);
  const legColorById = useMemo(() => {
    const m = new Map<string, string>();
    for (const leg of legs) m.set(leg.id, leg.color || DEFAULT_LEG_COLOR);
    return m;
  }, [legs]);

  useEffect(() => {
    const legIds = legIdsKey ? legIdsKey.split(",") : [];
    if (legIds.length === 0) {
      setTrails([]);
      return;
    }

    let cancelled = false;
    const api = tripApi(trip.id);
    setTrailsLoading(true);

    (async () => {
      const collected: TrailLine[] = [];
      for (const legId of legIds) {
        try {
          const raw = await api.listGpxForLeg(legId);
          if (cancelled) return;
          const legColor = legColorById.get(legId) || DEFAULT_LEG_COLOR;
          (raw as unknown as GpxTrailResponse[]).forEach((trail, idx) => {
            const trailColor = trail.color || legColor || TRAIL_FALLBACK_COLOR;
            const baseKey = `leg:${legId}#${trail.id ?? idx}`;
            trail.geojson?.features.forEach((feature, featureIdx) => {
              const lines: [number, number, number?][][] = [];
              if (feature.geometry.type === "LineString") {
                lines.push(feature.geometry.coordinates);
              } else if (feature.geometry.type === "MultiLineString") {
                lines.push(...feature.geometry.coordinates);
              }
              lines.forEach((line, lineIdx) => {
                const coords = gpxLineToCoords(line);
                if (coords.length < 2) return;
                collected.push({
                  key: `${baseKey}:${featureIdx}:${lineIdx}`,
                  color: trailColor,
                  coords,
                });
              });
            });
          });
        } catch (err) {
          // One bad leg shouldn't blank the other legs' trails — the web warns
          // and continues too.
          console.warn(`GPX fetch failed for leg ${legId}:`, err);
        }
      }
      if (cancelled) return;
      setTrails(collected);
      setTrailsLoading(false);
    })();

    return () => {
      cancelled = true;
      setTrailsLoading(false);
    };
  }, [legIdsKey, legColorById, trip.id]);

  // ── Fit to data ───────────────────────────────────────────────────────────
  const fitCoords = useMemo(() => {
    const pts: LatLng[] = [];
    for (const { leg, coords } of routes) {
      if (coords.length > 0) {
        pts.push(...coords);
      } else {
        if (leg.start_lat != null && leg.start_lng != null) {
          pts.push({ latitude: leg.start_lat, longitude: leg.start_lng });
        }
        if (leg.end_lat != null && leg.end_lng != null) {
          pts.push({ latitude: leg.end_lat, longitude: leg.end_lng });
        }
      }
    }
    return pts;
  }, [routes]);

  // Refit only when the route data itself changes. The web fits exactly once
  // (fittedRef) because a Google map re-fitting mid-session yanks the camera out
  // from under the user; keying on the route signature keeps that property for a
  // static trip while still honouring "fit on data change" when legs are added,
  // reordered or re-routed.
  const fitSignature = useMemo(() => legs.map(legRouteKey).join("|"), [legs]);
  const lastFitRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || fitCoords.length === 0) return;
    if (lastFitRef.current === fitSignature) return;
    lastFitRef.current = fitSignature;
    mapRef.current?.fitToCoordinates(fitCoords, {
      edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }, [ready, fitCoords, fitSignature]);

  // Pan to the selected leg WITHOUT disturbing zoom. animateCamera takes a
  // Partial<Camera>: passing only `center` leaves zoom/pitch/heading untouched,
  // which is the native equivalent of the web's `map.panTo()`. Deliberate — the
  // user picked their own zoom level and re-zooming on every list tap is
  // disorienting, so do NOT add a `zoom` here.
  useEffect(() => {
    if (!ready || selectedLegId == null) return;
    const leg = legs.find((l) => l.id === selectedLegId);
    if (!leg || leg.start_lat == null || leg.start_lng == null) return;
    mapRef.current?.animateCamera({
      center: { latitude: leg.start_lat, longitude: leg.start_lng },
    });
  }, [ready, selectedLegId, legs]);

  // Watchdog for the silent-blank-map failure (see MAP_READY_TIMEOUT_MS).
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setLoadError(MAP_TIMEOUT_MESSAGE), MAP_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setMapWidth(e.nativeEvent.layout.width);
  }, []);

  const handleMapReady = useCallback(() => {
    setReady(true);
    setLoadError(null);
  }, []);

  /**
   * Tapping a cluster fits the map to its members. Co-located members give a
   * zero-area bounds, and fitToCoordinates on that snaps to max zoom without ever
   * breaking the cluster apart — so nudge the zoom by two levels instead, exactly
   * as the web does. `camera.zoom` is Google-only (Apple Maps reports altitude),
   * so when it's missing we shrink the region deltas by 4× — the same two zoom
   * levels expressed in region terms.
   */
  const handleClusterPress = useCallback(async (members: MapStopPoint[]) => {
    const map = mapRef.current;
    if (!map || members.length === 0) return;

    const lats = members.map((m) => m.lat);
    const lngs = members.map((m) => m.lng);
    const spread =
      Math.max(...lats) - Math.min(...lats) + (Math.max(...lngs) - Math.min(...lngs));
    const center = {
      latitude: lats.reduce((s, v) => s + v, 0) / members.length,
      longitude: lngs.reduce((s, v) => s + v, 0) / members.length,
    };

    if (spread > 0) {
      map.fitToCoordinates(
        members.map((m) => ({ latitude: m.lat, longitude: m.lng })),
        {
          edgePadding: { top: 80, right: 80, bottom: 80, left: 80 },
          animated: true,
        }
      );
      return;
    }

    try {
      const camera = await map.getCamera();
      if (camera.zoom != null) {
        map.animateCamera({ center, zoom: Math.min(camera.zoom + 2, 18) });
        return;
      }
    } catch {
      // getCamera can reject if the view went away mid-gesture — fall through.
    }
    map.animateToRegion({
      latitude: center.latitude,
      longitude: center.longitude,
      latitudeDelta: Math.max(region.latitudeDelta / 4, 0.002),
      longitudeDelta: Math.max(region.longitudeDelta / 4, 0.002),
    });
  }, [region.latitudeDelta, region.longitudeDelta]);

  const lastLeg = legs.length > 0 ? legs[legs.length - 1] : null;

  // Fuel stops are sourced lazily when a day is opened in the list, so a trip the
  // user hasn't browsed has no stops to plot. Show a quiet hint so the empty map
  // reads as intentional rather than broken (see option B writeup).
  const hasLoadedStops = stopPoints.length > 0;
  const showNoStopsHint = ready && !loadError && legs.length > 0 && !hasLoadedStops;

  return (
    <View style={styles.container} onLayout={handleLayout}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={MAP_PROVIDER}
        // Google-only styling; silently ignored by Apple Maps, which is the
        // acceptable degradation when no Maps key is configured.
        customMapStyle={DARK_MAP_STYLE}
        initialRegion={FALLBACK_REGION}
        onMapReady={handleMapReady}
        // react-native-maps' 'settled camera' event — the web re-clusters on the
        // Google 'idle' event, which fires at the same moment.
        onRegionChangeComplete={setRegion}
        toolbarEnabled={false}
        rotateEnabled={false}
      >
        {/* Per-leg road-following polylines (or a dashed straight line while a
            leg has no stored geometry). */}
        {routes.map(({ leg, color, coords }) => {
          const isSelected = leg.id === selectedLegId;
          if (coords.length > 1) {
            return (
              <Polyline
                key={`route:${leg.id}`}
                coordinates={coords}
                strokeColor={withAlpha(color, isSelected ? 1 : 0.85)}
                strokeWidth={isSelected ? 6 : 4}
                zIndex={isSelected ? 10 : 1}
                tappable
                onPress={() => onLegSelect(leg.id)}
              />
            );
          }
          if (
            leg.start_lat == null ||
            leg.start_lng == null ||
            leg.end_lat == null ||
            leg.end_lng == null
          ) {
            return null;
          }
          return (
            <Polyline
              key={`route:${leg.id}`}
              coordinates={[
                { latitude: leg.start_lat, longitude: leg.start_lng },
                { latitude: leg.end_lat, longitude: leg.end_lng },
              ]}
              strokeColor={withAlpha(color, 0.5)}
              strokeWidth={2}
              lineDashPattern={[4, 8]}
              tappable
              onPress={() => onLegSelect(leg.id)}
            />
          );
        })}

        {gaps.map((gap) => (
          <Polyline
            key={gap.key}
            coordinates={gap.coords}
            strokeColor={withAlpha(GAP_COLOR, 0.7)}
            strokeWidth={3}
            lineDashPattern={[4, 8]}
            zIndex={0}
          />
        ))}

        {/* GPX trail overlays */}
        {trails.map((trail) => (
          <Polyline
            key={trail.key}
            coordinates={trail.coords}
            strokeColor={withAlpha(trail.color, 0.95)}
            strokeWidth={4}
            lineDashPattern={[2, 6]}
            zIndex={6}
          />
        ))}

        {/* Leg start markers */}
        {legs.map((leg) => {
          if (leg.start_lat == null || leg.start_lng == null) return null;
          const isSelected = leg.id === selectedLegId;
          const color = leg.color || DEFAULT_LEG_COLOR;
          const size = isSelected ? 18 : 14;
          return (
            <Marker
              key={`leg:${leg.id}`}
              coordinate={{ latitude: leg.start_lat, longitude: leg.start_lng }}
              // Custom marker views anchor at the pin tip by default; these are
              // dots, so center them on the coordinate.
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={isSelected ? 20 : 5}
              onPress={() => onLegSelect(leg.id)}
            >
              <View
                style={[
                  styles.dot,
                  {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: color,
                  },
                ]}
              />
              {/* The web opens this content in a hover InfoWindow. A phone has no
                  hover, so the same content becomes a Callout: the marker tap
                  fires onLegSelect AND pops the callout, giving touch users both
                  behaviours in one gesture. */}
              <Callout tooltip={false}>
                <View style={styles.callout}>
                  {leg.label ? <Text style={styles.calloutEyebrow}>{leg.label}</Text> : null}
                  <Text style={styles.calloutTitle}>{leg.title}</Text>
                  {leg.dates ? <Text style={styles.calloutBody}>{leg.dates}</Text> : null}
                  <Text style={styles.calloutBody}>
                    {leg.distance_km ? `${leg.distance_km} km` : ""}
                    {leg.drive_time_minutes
                      ? ` • ${Math.round(leg.drive_time_minutes / 60)} hrs`
                      : ""}
                  </Text>
                  {leg.overnight ? (
                    <Text style={styles.calloutFootnote}>{leg.overnight}</Text>
                  ) : null}
                </View>
              </Callout>
            </Marker>
          );
        })}

        {/* Final destination marker */}
        {lastLeg && lastLeg.end_lat != null && lastLeg.end_lng != null ? (
          <Marker
            key="final-destination"
            coordinate={{ latitude: lastLeg.end_lat, longitude: lastLeg.end_lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={30}
          >
            <View
              style={[
                styles.destinationDot,
                { backgroundColor: lastLeg.color || DESTINATION_COLOR },
              ]}
            />
            <Callout tooltip={false}>
              <View style={styles.callout}>
                {/* The web hardcodes "Nordkapp" / "71.17°N — The Goal" (it shipped
                    for one trip). Prefer the leg's real end_name when we have it
                    and keep the web's exact copy as the fallback. */}
                <Text style={styles.calloutDestination}>
                  {lastLeg.end_name || "Nordkapp"}
                </Text>
                <Text style={styles.calloutBody}>71.17°N — The Goal</Text>
              </View>
            </Callout>
          </Marker>
        ) : null}

        {/* POI markers */}
        {pois.map((poi) => (
          <Marker
            key={`poi:${poi.id}`}
            coordinate={{ latitude: poi.lat, longitude: poi.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={2}
            // The web renders an <a> in the InfoWindow; native opens the same URL
            // through the OS when the callout itself is tapped.
            onCalloutPress={() => {
              if (poi.url) void Linking.openURL(poi.url);
            }}
          >
            <View style={styles.poiDot} />
            <Callout tooltip={false}>
              <View style={styles.callout}>
                <Text style={styles.calloutTitle}>{poi.name}</Text>
                <Text style={styles.calloutBody}>
                  {poi.source}
                  {poi.rating ? ` • ★ ${poi.rating}` : ""}
                </Text>
                {poi.url ? (
                  <Text style={styles.calloutLink}>View on source →</Text>
                ) : null}
              </View>
            </Callout>
          </Marker>
        ))}

        {/* Stop markers (fuel + user-added), clustered */}
        {stopGroups.map((members) => {
          if (members.length === 0) return null;
          if (members.length === 1) {
            const p = members[0];
            const isFuel = p.type === "fuel";
            return (
              <Marker
                key={`stop:${p.stopId}`}
                coordinate={{ latitude: p.lat, longitude: p.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                zIndex={8}
                onPress={() => onStopSelect(p.legId, p.stopId)}
              >
                {/* Square glyph so stops read differently from the round leg /
                    destination dots. Gold = fuel, slate = user-added. */}
                <View
                  style={[
                    styles.stopSquare,
                    { backgroundColor: isFuel ? FUEL_STOP_COLOR : OTHER_STOP_COLOR },
                  ]}
                />
                <Callout tooltip={false}>
                  <View style={styles.callout}>
                    <Text
                      style={[
                        styles.calloutEyebrow,
                        isFuel ? styles.calloutEyebrowFuel : null,
                      ]}
                    >
                      {isFuel ? "FUEL" : "STOP"}
                    </Text>
                    <Text style={styles.calloutTitle}>{p.name}</Text>
                    {p.distanceKm != null ? (
                      <Text style={styles.calloutBody}>
                        {Math.round(p.distanceKm)} km from start
                      </Text>
                    ) : null}
                    {/* Web says "Click to open in list" — same action, touch wording. */}
                    <Text style={styles.calloutFootnote}>Tap to open in list</Text>
                  </View>
                </Callout>
              </Marker>
            );
          }

          const count = members.length;
          const size = 24 + Math.min(count, 9) * 2;
          const center = {
            latitude: members.reduce((s, m) => s + m.lat, 0) / count,
            longitude: members.reduce((s, m) => s + m.lng, 0) / count,
          };
          return (
            <Marker
              key={`cluster:${members[0].stopId}:${count}`}
              coordinate={center}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={9}
              onPress={() => void handleClusterPress(members)}
            >
              <View
                style={[
                  styles.cluster,
                  { width: size, height: size, borderRadius: size / 2 },
                ]}
              >
                <Text style={styles.clusterLabel}>{count}</Text>
              </View>
            </Marker>
          );
        })}
      </MapView>

      {loadError ? (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.errorText}>Map failed to load.</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
        </View>
      ) : null}

      {!ready && !loadError ? (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <Spinner />
          <Text style={styles.loadingText}>Loading Google Maps…</Text>
        </View>
      ) : null}

      {showNoStopsHint ? (
        <View style={styles.hint} pointerEvents="none">
          <Text style={styles.hintText} numberOfLines={1}>
            Open a day to load its fuel stops
          </Text>
        </View>
      ) : null}

      {trailsLoading && ready ? (
        <View style={styles.trailsBadge} pointerEvents="none">
          <Spinner />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // src/components/TripMap.tsx:757 — background: var(--tp-map-chrome)
    flex: 1,
    backgroundColor: theme.mapChrome,
  },
  // src/components/TripMap.tsx:389/428/454/518/562 — every marker is stroked
  // strokeColor: '#ffffff'; only the weight changes per marker class.
  dot: {
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  destinationDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 3,
    borderColor: "#ffffff",
  },
  poiDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#ffffff",
    backgroundColor: POI_COLOR,
    opacity: 0.7,
  },
  stopSquare: {
    width: 10,
    height: 10,
    borderWidth: 1.5,
    borderColor: "#ffffff",
  },
  cluster: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: CLUSTER_COLOR,
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  clusterLabel: {
    color: "#ffffff",
    fontSize: 11,
    fontFamily: font.bold,
  },
  callout: {
    minWidth: 160,
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  calloutEyebrow: {
    fontSize: 10,
    color: theme.muted,
    fontFamily: font.bold,
    letterSpacing: 0.6,
  },
  calloutEyebrowFuel: {
    color: FUEL_STOP_COLOR,
  },
  calloutTitle: {
    fontSize: 14,
    fontFamily: font.semibold,
    color: theme.text,
    marginVertical: 2,
  },
  calloutDestination: {
    fontSize: 16,
    fontFamily: font.bold,
    color: theme.text,
  },
  calloutBody: {
    fontFamily: font.regular,
    fontSize: 12,
    // src/components/TripMap.tsx:403 — the info-window body literal.
    color: "#6b6b6b",
  },
  calloutFootnote: {
    fontFamily: font.regular,
    fontSize: 10,
    // src/components/TripMap.tsx:535 — `color: #aaa`.
    color: "#aaaaaa",
    marginTop: 4,
  },
  calloutLink: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.primary,
    marginTop: 4,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    // src/components/TripMap.tsx:766 — background: var(--tp-overlay)
    backgroundColor: theme.overlay,
  },
  errorText: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 21,
    color: theme.text,
    textAlign: "center",
  },
  errorDetail: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 19,
    color: theme.muted,
    textAlign: "center",
    marginTop: 6,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    // src/components/TripMap.tsx:788 — background: var(--tp-map-chrome)
    backgroundColor: theme.mapChrome,
  },
  loadingText: {
    fontFamily: font.regular,
    fontSize: 13,
    color: theme.muted,
  },
  hint: {
    position: "absolute",
    bottom: 16,
    alignSelf: "center",
    maxWidth: "85%",
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    ...shadow.sm,
  },
  hintText: {
    fontFamily: font.regular,
    fontSize: 12,
    color: theme.muted,
  },
  trailsBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: theme.surface,
    borderRadius: 999,
    padding: 8,
    // The only `shadow.sm` site with no edge of its own. `sm` is an inert
    // object now (see mobile/lib/theme.ts), so on a dark ground this floated
    // over the map with nothing separating it from the tiles.
    borderWidth: 1,
    borderColor: theme.border,
    ...shadow.sm,
  },
});
