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
