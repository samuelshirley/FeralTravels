/**
 * Coordinate parsing utilities.
 *
 * Handles the formats users copy out of the wild — decimal degrees, DMS,
 * Google Maps URLs, Apple Maps URLs.
 *
 * Pure + synchronous. For maps.app.goo.gl short links that need redirect
 * expansion, use POST /api/coords/parse which falls back to server-side
 * resolution.
 *
 * iOverlander / Park4Night URL parsing was removed: their public pages
 * don't expose coords on the URL or in a stable HTML shape, and scraping
 * their site crosses their terms. The UI now only accepts Google/Apple
 * Maps URLs or raw lat/lng — users pasting a P4N/iOverlander URL get a
 * clear error telling them to copy the coords instead.
 */

export interface ParsedCoords {
  lat: number;
  lng: number;
  /** Optional place name extracted from the URL or string. */
  name?: string;
  /** Rough provenance for debugging / seeding the stop `source` column. */
  source?: 'google_maps' | 'apple_maps' | 'manual';
  /** The original URL, if the input was a URL. */
  source_url?: string;
}

const LAT_RANGE = [-90, 90] as const;
const LNG_RANGE = [-180, 180] as const;

function inRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= LAT_RANGE[0] &&
    lat <= LAT_RANGE[1] &&
    lng >= LNG_RANGE[0] &&
    lng <= LNG_RANGE[1]
  );
}

/** "48.8566, 2.3522" or "48.8566 2.3522" or "48.8566;2.3522". */
function parseDecimalPair(input: string): ParsedCoords | null {
  const m = input
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!inRange(lat, lng)) return null;
  return { lat, lng, source: 'manual' };
}

/**
 * DMS — e.g. "48°51'24.0"N 2°21'08.0"E" or "48 51 24 N, 2 21 8 E".
 * We're lenient about separators and allow signs to replace hemisphere letters.
 */
function parseDMS(input: string): ParsedCoords | null {
  const s = input.trim().toUpperCase().replace(/[′'`]/g, "'").replace(/[″"]/g, '"');
  const partRegex = /(-?\d+(?:\.\d+)?)\s*(?:[°D]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:['M]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["S]\s*)?)?)?\s*([NSEW])?/g;

  const parts: { dd: number; hemi: string | null }[] = [];
  let match: RegExpExecArray | null;
  while ((match = partRegex.exec(s)) && parts.length < 2) {
    const [, degStr, minStr, secStr, hemi] = match;
    const deg = parseFloat(degStr);
    const min = minStr ? parseFloat(minStr) : 0;
    const sec = secStr ? parseFloat(secStr) : 0;
    if (!Number.isFinite(deg)) continue;
    if (minStr === undefined && hemi === undefined) continue; // Skip plain numbers that already matched decimal regex.
    let dd = Math.abs(deg) + min / 60 + sec / 3600;
    if (deg < 0) dd = -dd;
    parts.push({ dd, hemi: hemi || null });
  }
  if (parts.length !== 2) return null;

  const [a, b] = parts;
  const aIsLat = a.hemi === 'N' || a.hemi === 'S' || (b.hemi === 'E' || b.hemi === 'W');
  let lat: number;
  let lng: number;
  if (aIsLat) {
    lat = a.dd * (a.hemi === 'S' ? -1 : 1);
    lng = b.dd * (b.hemi === 'W' ? -1 : 1);
  } else {
    lat = b.dd * (b.hemi === 'S' ? -1 : 1);
    lng = a.dd * (a.hemi === 'W' ? -1 : 1);
  }
  if (!inRange(lat, lng)) return null;
  return { lat, lng, source: 'manual' };
}

function decodeName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).trim() || undefined;
  } catch {
    return raw.replace(/\+/g, ' ').trim() || undefined;
  }
}

/**
 * Google Maps URLs — covers the common shapes:
 *   maps.google.com/?q=LAT,LNG
 *   google.com/maps?q=LAT,LNG
 *   google.com/maps/place/Name/@LAT,LNG,15z
 *   google.com/maps/@LAT,LNG,17z
 *   google.com/maps/dir/.../LAT,LNG
 *   /search/LAT,LNG
 *   !3dLAT!4dLNG (internal place URL)
 *
 * NOT covered: maps.app.goo.gl short links (need server redirect expansion).
 */
function parseGoogleMapsUrl(url: URL): ParsedCoords | null {
  const host = url.hostname.replace(/^www\./, '');
  if (!/(^|\.)google\.[a-z.]+$/.test(host) && host !== 'goo.gl') return null;

  let name: string | undefined;
  const placeMatch = url.pathname.match(/\/place\/([^/@]+)/);
  if (placeMatch) name = decodeName(placeMatch[1]);

  const q = url.searchParams.get('q') || url.searchParams.get('query');
  if (q) {
    const pair = parseDecimalPair(q);
    if (pair) return { ...pair, name, source: 'google_maps', source_url: url.toString() };
  }

  const atMatch = url.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (inRange(lat, lng)) return { lat, lng, name, source: 'google_maps', source_url: url.toString() };
  }

  const bangMatch = url.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bangMatch) {
    const lat = parseFloat(bangMatch[1]);
    const lng = parseFloat(bangMatch[2]);
    if (inRange(lat, lng)) return { lat, lng, name, source: 'google_maps', source_url: url.toString() };
  }

  const pathMatch = url.pathname.match(/\/(-?\d+\.\d+),(-?\d+\.\d+)(?:[/?]|$)/);
  if (pathMatch) {
    const lat = parseFloat(pathMatch[1]);
    const lng = parseFloat(pathMatch[2]);
    if (inRange(lat, lng)) return { lat, lng, name, source: 'google_maps', source_url: url.toString() };
  }

  return null;
}

/** Apple Maps — maps.apple.com/?ll=LAT,LNG&q=Name */
function parseAppleMapsUrl(url: URL): ParsedCoords | null {
  if (!/(^|\.)apple\.com$/.test(url.hostname)) return null;
  const ll = url.searchParams.get('ll') || url.searchParams.get('sll');
  if (!ll) return null;
  const pair = parseDecimalPair(ll);
  if (!pair) return null;
  return {
    ...pair,
    name: decodeName(url.searchParams.get('q')),
    source: 'apple_maps',
    source_url: url.toString(),
  };
}

function parseUrl(input: string): ParsedCoords | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  return parseGoogleMapsUrl(url) || parseAppleMapsUrl(url);
}

/**
 * Top-level synchronous parser. Returns null for URLs that require server-side
 * redirect expansion (maps.app.goo.gl short links that hide their canonical
 * lat/lng behind a 30x). Those are handled by POST /api/coords/parse.
 */
export function parseCoords(input: string): ParsedCoords | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) return parseUrl(trimmed);

  return parseDecimalPair(trimmed) || parseDMS(trimmed);
}

/**
 * Hosts that require a network round trip to resolve. The `/api/coords/parse`
 * endpoint follows redirects so short links expand to their canonical Google
 * Maps URL.
 */
export function needsServerResolution(input: string): boolean {
  if (!/^https?:\/\//i.test(input)) return false;
  try {
    const url = new URL(input.trim());
    const host = url.hostname.replace(/^www\./, '');
    return host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co';
  } catch {
    return false;
  }
}
