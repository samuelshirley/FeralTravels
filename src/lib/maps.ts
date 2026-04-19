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

/** Construct a fresh nav-mode directions URL from raw lat/lng. */
export function buildNavUrl(coords: LegCoords): string | null {
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
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Return a "Go" URL for a Google Maps link.
 *
 * Strategy:
 * 1. If the original URL is already a Maps directions URL, ensure it has
 *    `dir_action=navigate` and `travelmode=driving` and pass through.
 * 2. If the original URL is a Maps short link / place URL, fall back to
 *    constructing a fresh nav URL from the leg's start/end coords.
 * 3. If we can't do either, return the original (so users at least get
 *    *something*).
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
      // Ensure nav params are present without overwriting an explicit travelmode.
      if (!u.searchParams.has('api')) u.searchParams.set('api', '1');
      if (!u.searchParams.has('travelmode')) u.searchParams.set('travelmode', 'driving');
      u.searchParams.set('dir_action', 'navigate');
      return u.toString();
    }

    // Place / preview / short link — rebuild from leg coords if we can.
    const fromCoords = buildNavUrl(coords);
    return fromCoords ?? originalUrl;
  } catch {
    // Not a parseable URL — fall back to coords-only nav URL if available.
    return buildNavUrl(coords) ?? originalUrl;
  }
}
