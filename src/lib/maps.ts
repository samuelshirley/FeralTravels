/**
 * Google Maps URL helpers — emit URLs that open in turn-by-turn navigation
 * mode (not preview).
 *
 * Maps URLs API reference: https://developers.google.com/maps/documentation/urls/get-started
 *
 * Key parameter: `dir_action=navigate` — when present on a Maps directions URL
 * opened on a device with the Google Maps app, it triggers Google Maps to
 * launch directly into navigation. Without it, Maps just shows the route
 * preview and you have to tap the "Start" button.
 */

export interface LegCoords {
  start_lat?: number | null;
  start_lng?: number | null;
  end_lat?: number | null;
  end_lng?: number | null;
}

/**
 * Construct a fresh nav-mode directions URL from raw lat/lng.
 *
 * `waypoints` is optional; when provided, each `[lat, lng]` becomes a
 * pipe-delimited stop on the way (Google Maps URLs API supports `&waypoints=`).
 */
export function buildNavUrl(
  coords: LegCoords,
  waypoints?: Array<[number, number]>
): string | null {
  const { start_lat, start_lng, end_lat, end_lng } = coords;
  if (end_lat == null || end_lng == null) return null;
  const params = new URLSearchParams({
    api: '1',
    destination: `${end_lat},${end_lng}`,
    travelmode: 'driving',
    dir_action: 'navigate',
  });
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

/**
 * Build the unified "Open in Google Maps" URL for a leg. Combines the leg's
 * start/end coords with (a) the selected route's end-override (if any) and
 * (b) any user-selected stops (fuel, water, overnight, etc) as waypoints.
 *
 * Waypoints are sorted by `distance_from_start_km` when available, falling
 * back to `sort_order` so the nav route follows the intended driving sequence.
 */
export function buildLegDirectionsUrl(input: {
  legCoords: LegCoords;
  selectedRoute?: {
    end_lat: number | null;
    end_lng: number | null;
  } | null;
  selectedStops?: Array<{
    lat: number | null;
    lng: number | null;
    distance_from_start_km?: number | null;
    sort_order?: number | null;
  }>;
}): string | null {
  const { legCoords, selectedRoute, selectedStops } = input;
  const destLat = selectedRoute?.end_lat ?? legCoords.end_lat ?? null;
  const destLng = selectedRoute?.end_lng ?? legCoords.end_lng ?? null;
  if (destLat == null || destLng == null) return null;

  const waypoints = (selectedStops ?? [])
    .filter((s): s is { lat: number; lng: number; distance_from_start_km?: number | null; sort_order?: number | null } =>
      s.lat != null && s.lng != null
    )
    .slice()
    .sort((a, b) => {
      const ad = a.distance_from_start_km ?? Number.POSITIVE_INFINITY;
      const bd = b.distance_from_start_km ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    })
    .map((s) => [s.lat, s.lng] as [number, number]);

  return buildNavUrl(
    { ...legCoords, end_lat: destLat, end_lng: destLng },
    waypoints.length > 0 ? waypoints : undefined
  );
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
