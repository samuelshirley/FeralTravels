/**
 * Google Maps URL helpers for driving directions.
 *
 * Maps URLs API reference: https://developers.google.com/maps/documentation/urls/get-started
 *
 * `dir_action=navigate` starts turn-by-turn immediately; multi-stop legs omit it
 * so Maps opens the full itinerary preview first (better for many waypoints).
 */
import { haversineKm } from '../lib/polyline';

export interface LegCoords {
  start_lat?: number | null;
  start_lng?: number | null;
  end_lat?: number | null;
  end_lng?: number | null;
}

export type NavUrlOptions = {
  /**
   * When true (default), adds `dir_action=navigate` for immediate turn-by-turn.
   * Omit for multi-stop routes so Maps opens the full directions preview first
   * (closer to a shared “multiple stops” link on phones).
   */
  navigate?: boolean;
};

/**
 * Construct a directions URL from raw lat/lng.
 *
 * `waypoints` is optional; when provided, each `[lat, lng]` becomes a
 * pipe-delimited stop on the way (Google Maps URLs API supports `&waypoints=`).
 */
export function buildNavUrl(
  coords: LegCoords,
  waypoints?: Array<[number, number]>,
  opts?: NavUrlOptions
): string | null {
  const { start_lat, start_lng, end_lat, end_lng } = coords;
  if (end_lat == null || end_lng == null) return null;
  const navigate = opts?.navigate !== false;
  const params = new URLSearchParams({
    api: '1',
    destination: `${end_lat},${end_lng}`,
    travelmode: 'driving',
  });
  if (navigate) {
    params.set('dir_action', 'navigate');
  }
  if (start_lat != null && start_lng != null) {
    params.set('origin', `${start_lat},${start_lng}`);
  }
  if (waypoints && waypoints.length > 0) {
    const valid = waypoints.filter(
      ([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)
    );
    if (valid.length > 0) {
      params.set(
        'waypoints',
        valid.map(([lat, lng]) => `${lat},${lng}`).join('|')
      );
    }
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Build a Google Maps "search near a point" URL using the path-style
 * /maps/search/<query>/@lat,lng,Nz form.
 *
 * This is the shape Google's web maps has supported for years and is the
 * most reliable cross-device way to land centered on a coordinate with a
 * search overlay: on iOS with the Google Maps app installed the browser
 * universal-links it, on Android it opens the app via intent filters, and
 * on desktop it opens maps.google.com centered exactly there.
 *
 * The official Maps URLs API `/maps/search/?api=1&query=...` format does
 * not accept a center hint, so we can't use it for near-point searches.
 *
 * `zoom` 13 is a neighborhood-scale view — wide enough to see the next
 * town but tight enough to see individual parks.
 */
export function buildMapsSearchUrl(
  lat: number,
  lng: number,
  query: string,
  zoom = 13
): string {
  const q = encodeURIComponent(query);
  return `https://www.google.com/maps/search/${q}/@${lat},${lng},${zoom}z`;
}

/** "Dog parks near this point" Google Maps search. */
export function buildDogParkSearchUrl(lat: number, lng: number): string {
  return buildMapsSearchUrl(lat, lng, 'dog park');
}

/** "Parks near this point" Google Maps search (covers regular parks too). */
export function buildParkSearchUrl(lat: number, lng: number): string {
  return buildMapsSearchUrl(lat, lng, 'park');
}

/** Stops that can be turned into Maps waypoints (see buildLegDirectionsUrl). */
export type LegDirectionsStopInput = {
  lat: number | null;
  lng: number | null;
  status: string;
  stop_type: string;
  name: string;
  source: string | null;
  distance_from_start_km?: number | null;
  sort_order?: number | null;
};

/** A resolved waypoint with coords and name. */
export type ResolvedWaypoint = { lat: number; lng: number; name: string; stopType?: string };

/** Filter & sort stops into the set that appear in directions URLs. */
function resolveDirectionsStops(stops: LegDirectionsStopInput[]): ResolvedWaypoint[] {
  const fuelWithCoords = (s: LegDirectionsStopInput) =>
    s.stop_type === 'fuel' && s.lat != null && s.lng != null;
  const nonFuelSelected = (s: LegDirectionsStopInput) =>
    s.stop_type !== 'fuel' && s.status === 'selected' && s.lat != null && s.lng != null;

  return stops
    .filter(
      (s) =>
        s.status !== 'dismissed' &&
        s.lat != null &&
        s.lng != null &&
        (nonFuelSelected(s) || fuelWithCoords(s))
    )
    .slice()
    .sort((a, b) => {
      const ad = a.distance_from_start_km ?? Number.POSITIVE_INFINITY;
      const bd = b.distance_from_start_km ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    })
    .map((s) => ({ lat: s.lat as number, lng: s.lng as number, name: s.name, stopType: s.stop_type }));
}

/** Sorted intermediate coords for leg directions (badge counts, tests). */
export function legDirectionsWaypoints(stops: LegDirectionsStopInput[]): Array<[number, number]> {
  return resolveDirectionsStops(stops).map((w) => [w.lat, w.lng] as [number, number]);
}

/**
 * Build the unified "Open in Google Maps" URL for a leg. Combines the leg's
 * start/end coords with (a) the selected route's end-override (if any) and
 * (b) waypoints: every **selected** non-fuel stop with coords, plus every
 * **fuel** stop with coords (any `source`: google_places, penny, user) unless
 * dismissed.
 *
 * Always uses `dir_action=navigate` so Google Maps launches straight into
 * turn-by-turn on mobile. Omitting it for multi-stop routes caused Maps to
 * open the route-planning view instead ("Dropped pin" for each waypoint),
 * which often got stuck and never launched navigation.
 */
export function buildLegDirectionsUrl(input: {
  legCoords: LegCoords;
  selectedRoute?: {
    end_lat: number | null;
    end_lng: number | null;
  } | null;
  stops?: LegDirectionsStopInput[] | null;
}): string | null {
  const { legCoords, selectedRoute, stops } = input;
  const destLat = selectedRoute?.end_lat ?? legCoords.end_lat ?? null;
  const destLng = selectedRoute?.end_lng ?? legCoords.end_lng ?? null;
  if (destLat == null || destLng == null) return null;

  const waypoints = legDirectionsWaypoints(stops ?? []);

  return buildNavUrl(
    { ...legCoords, end_lat: destLat, end_lng: destLng },
    waypoints.length > 0 ? waypoints : undefined,
    { navigate: true }
  );
}

/** One navigation button — destination only, no origin (uses device GPS). */
export type NavSegment = { label: string; url: string; stopType?: string };

/**
 * How close two points have to be before a driver would call them the same
 * place. 1 km, the same number `add_stop` already uses to reject a stop sitting
 * on top of a leg's end coords — one threshold for "you are already here"
 * rather than two that drift apart.
 */
export const SAME_PLACE_KM = 1;

/**
 * True when a leg ends where it starts and no driving happens in between: a
 * rest day, or any other day spent parked at one location.
 *
 * WHY THIS EXISTS (2026-08-27). A rest day is stored as a leg whose start and
 * end are the SAME coordinates — `add_leg` insists on it ("use the same coords
 * for start and end — the rest day is AT a location"). `buildSegmentedNavUrls`
 * then appended a destination button for it exactly like any other leg, so a
 * day titled "Porto (rest day)", with no distance and no duration, offered
 * "Route to Destination — Porto". The URL carries no `origin`, so Google Maps
 * takes the origin from device GPS — and on that day the driver IS in Porto.
 * The button launched turn-by-turn navigation to where he was already standing.
 *
 * The coordinate check ALONE would be wrong. A genuine day-loop — out into the
 * Douro valley and back to Porto — also starts and ends in the same place, and
 * that driver does want a button home. So a leg is only stationary when it also
 * carries no distance and no drive time, which is precisely how a rest day is
 * written and precisely how a loop is not. Missing start coords means we cannot
 * tell, and we keep the button: a redundant button beats a missing one.
 *
 * A stationary leg is the ONE case where a rendered nav list legitimately holds
 * no destination button. Any invariant asserting "if the app renders navigation
 * at all, one of those buttons reaches the end of the leg" needs this as its
 * carve-out, because here there is no end to reach.
 */
export function isStationaryLeg(input: {
  legCoords: LegCoords;
  destination: { lat: number; lng: number };
  distanceKm?: number | null;
  driveTimeMinutes?: number | null;
}): boolean {
  const { legCoords, destination, distanceKm, driveTimeMinutes } = input;
  if (legCoords.start_lat == null || legCoords.start_lng == null) return false;
  if ((distanceKm ?? 0) >= SAME_PLACE_KM) return false;
  if ((driveTimeMinutes ?? 0) > 0) return false;
  return (
    haversineKm({ lat: legCoords.start_lat, lng: legCoords.start_lng }, destination) < SAME_PLACE_KM
  );
}

/**
 * Build a list of "navigate from current location → stop" buttons for a leg.
 *
 * Each URL omits `origin` so Google Maps defaults to the device's GPS
 * position and always shows the "Start" turn-by-turn button on mobile.
 * (Google Maps suppresses the Start button when `waypoints` are present,
 * and setting an explicit `origin` when the user has already driven past
 * it produces a U-turn at the top of the route.)
 *
 * The list includes every qualifying intermediate stop (sorted by distance)
 * followed by the leg's final destination. For a leg with zero stops this
 * returns a single-element array pointing at the destination.
 *
 * EXCEPTION: a stationary leg (see `isStationaryLeg` — a rest day, where the
 * driver ends the day where he started it) gets NO destination entry, because
 * navigating to it means navigating to where he already is. Its added stops
 * still get their own buttons: "drive me to the restaurant" is real work on a
 * rest day; "drive me to Porto, from Porto" is not.
 *
 * Returns `null` when destination coords are missing, and for a stationary leg
 * with no stops of its own — in both cases there is nothing to navigate to and
 * the caller renders no nav block at all.
 */
export function buildSegmentedNavUrls(input: {
  legCoords: LegCoords;
  endName?: string | null;
  selectedRoute?: {
    end_lat: number | null;
    end_lng: number | null;
  } | null;
  stops?: LegDirectionsStopInput[] | null;
  /** Leg headline distance — what separates a rest day from a day-loop. */
  distanceKm?: number | null;
  /** Leg headline drive time — same purpose as `distanceKm`. */
  driveTimeMinutes?: number | null;
}): NavSegment[] | null {
  const { legCoords, endName, selectedRoute, stops, distanceKm, driveTimeMinutes } = input;
  const destLat = selectedRoute?.end_lat ?? legCoords.end_lat ?? null;
  const destLng = selectedRoute?.end_lng ?? legCoords.end_lng ?? null;
  if (destLat == null || destLng == null) return null;

  const resolved = resolveDirectionsStops(stops ?? []);

  // A rest day has nowhere to drive to, so it is offered nothing to drive to.
  const stationary = isStationaryLeg({
    legCoords,
    destination: { lat: destLat, lng: destLng },
    distanceKm,
    driveTimeMinutes,
  });

  // Ordered destinations: intermediate stops, then final destination.
  type Dest = { lat: number; lng: number; name: string; stopType?: string };
  const destinations: Dest[] = [
    ...resolved,
    ...(stationary
      ? []
      : [{ lat: destLat, lng: destLng, name: endName || 'Destination', stopType: 'destination' }]),
  ];

  const segments: NavSegment[] = [];
  for (const dest of destinations) {
    // No origin → Google Maps uses device GPS = always shows "Start" button.
    const url = buildNavUrl(
      { end_lat: dest.lat, end_lng: dest.lng },
      undefined,
      { navigate: true }
    );
    if (url) {
      segments.push({ label: dest.name, url, stopType: dest.stopType });
    }
  }

  return segments.length > 0 ? segments : null;
}

/**
 * Return a "Go" URL for a Google Maps link.
 *
 * Strategy:
 * 1. If the URL is already in the **API-style** directions format
 *    (`/maps/dir/?api=1&origin=...&destination=...`) just inject
 *    `dir_action=navigate` so it launches turn-by-turn directly.
 * 2. If the URL is **path-style** (`/maps/dir/Girona/Genoa`), DON'T just
 *    append `?api=1` — Google Maps mobile cannot mix the two formats and
 *    will fall back to navigating only to the first path segment. Rebuild
 *    a fresh API-style URL from the leg coords instead.
 * 3. For Maps short links / place URLs, fall back to building from coords.
 * 4. If coords are unavailable, return the original URL untouched (better
 *    than no link at all).
 */
export function rewriteMapsUrlForNav(originalUrl: string, coords: LegCoords): string {
  try {
    const u = new URL(originalUrl);
    const host = u.hostname.toLowerCase();
    const isGoogleMaps =
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'maps.google.com' ||
      host === 'maps.app.goo.gl' ||
      host === 'goo.gl';
    if (!isGoogleMaps) return originalUrl;

    const isDirections = u.pathname.includes('/maps/dir');
    if (isDirections) {
      // API-style directions URL: pathname is exactly /maps/dir or /maps/dir/
      // and the route is encoded in `?origin=...&destination=...`. We can
      // safely pass through after upgrading to nav mode.
      const isApiStyle =
        u.searchParams.has('origin') ||
        u.searchParams.has('destination') ||
        /^\/maps\/dir\/?$/.test(u.pathname);
      if (isApiStyle) {
        if (!u.searchParams.has('api')) u.searchParams.set('api', '1');
        if (!u.searchParams.has('travelmode')) u.searchParams.set('travelmode', 'driving');
        u.searchParams.set('dir_action', 'navigate');
        return u.toString();
      }
      // Path-style like `/maps/dir/Girona/Genoa` — rebuild from coords if we
      // can, otherwise fall back to the original (still better than a broken
      // hybrid URL).
      const fromCoords = buildNavUrl(coords);
      return fromCoords ?? originalUrl;
    }

    // Place / preview / short link — rebuild from leg coords if we can.
    const fromCoords = buildNavUrl(coords);
    return fromCoords ?? originalUrl;
  } catch {
    // Not a parseable URL — fall back to coords-only nav URL if available.
    return buildNavUrl(coords) ?? originalUrl;
  }
}
