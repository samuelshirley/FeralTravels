'use client';

import { setOptions, importLibrary } from '@googlemaps/js-api-loader';

// Mirrors TripMap's module-global guard so we configure the loader key at most
// once per page, whether the map mounted first or this helper ran first.
let optionsConfigured = false;

/**
 * Best-effort reverse geocode: coordinates → a short human-readable place label
 * (e.g. "Bergen, Norway"), using the already-enabled Google Maps JS Geocoder.
 *
 * Client-only and deliberately forgiving: any failure (loader unavailable, key
 * missing, Geocoding API not enabled, no result) resolves to `null` rather than
 * throwing. Callers store the coordinates regardless — the label is a nicety
 * that lets Penny/UI show a name instead of raw lat/lng.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return null;
    if (!optionsConfigured) {
      setOptions({ key: apiKey, v: 'weekly' });
      optionsConfigured = true;
    }
    const { Geocoder } = (await importLibrary('geocoding')) as google.maps.GeocodingLibrary;
    const geocoder = new Geocoder();
    const { results } = await geocoder.geocode({ location: { lat, lng } });
    if (!results || results.length === 0) return null;

    // Prefer a locality-level result ("town, region"); fall back to the most
    // specific formatted address Google returns.
    const locality = results.find((r) =>
      r.types.some((t) => t === 'locality' || t === 'postal_town'),
    );
    const chosen = locality ?? results[0];
    return shorten(chosen.formatted_address);
  } catch {
    return null;
  }
}

/**
 * Trim a full formatted address down to the meaningful head — Google returns
 * things like "5003 Bergen, Norway"; we keep the last two comma-parts so the
 * label reads like a place, not a mailing address, and clamp the length.
 */
function shorten(formatted: string | null | undefined): string | null {
  if (!formatted) return null;
  const parts = formatted.split(',').map((p) => p.trim()).filter(Boolean);
  const label = (parts.length > 2 ? parts.slice(-2) : parts).join(', ');
  return label.slice(0, 200) || null;
}
