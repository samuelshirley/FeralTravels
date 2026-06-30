import 'server-only';
import { parseCoords, needsServerResolution, type ParsedCoords } from '@/lib/coords';
import { geocodePlace } from '@/lib/google/geocode';

const FETCH_TIMEOUT_MS = 5000;
const MAX_MAPS_LINKS_PER_MESSAGE = 5;

/** URL token in free text — stops at whitespace or common trailing punctuation. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export type ResolvedMapsLink = {
  url: string;
  resolved: boolean;
  lat?: number;
  lng?: number;
  name?: string;
  source_url?: string;
  error?: string;
};

/**
 * Resolve coordinates from user input — sync parse first, then short-link
 * redirect expansion for maps.app.goo.gl / goo.gl / g.co.
 */
export async function resolveCoordsFromInput(input: string): Promise<ParsedCoords | null> {
  const direct = parseCoords(input);
  if (direct) return direct;

  if (!needsServerResolution(input)) return null;

  return resolveShortLinkUrl(input.trim());
}

/** Extract http(s) URLs from prose (deduped, order preserved). */
export function extractUrlsFromText(message: string): string[] {
  const matches = message.match(URL_IN_TEXT_RE);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function looksLikeMapsUrl(url: string): boolean {
  return parseCoords(url) !== null || needsServerResolution(url);
}

/**
 * Find Google/Apple Maps links in a chat message and resolve each to lat/lng.
 * Used by Penny replan to enrich the user turn before Claude sees it.
 */
export async function resolveMapsLinksInMessage(message: string): Promise<ResolvedMapsLink[]> {
  const urls = extractUrlsFromText(message).filter(looksLikeMapsUrl).slice(0, MAX_MAPS_LINKS_PER_MESSAGE);

  if (urls.length === 0) return [];

  const results = await Promise.all(
    urls.map(async (url): Promise<ResolvedMapsLink> => {
      try {
        const parsed = await resolveCoordsFromInput(url);
        if (parsed) {
          return {
            url,
            resolved: true,
            lat: parsed.lat,
            lng: parsed.lng,
            name: parsed.name,
            source_url: parsed.source_url ?? url,
          };
        }
        return {
          url,
          resolved: false,
          error: 'Could not resolve coordinates from that URL.',
        };
      } catch {
        return {
          url,
          resolved: false,
          error: 'Failed to fetch or parse that URL.',
        };
      }
    })
  );

  return results;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveShortLinkUrl(input: string): Promise<ParsedCoords | null> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'maps.app.goo.gl' && host !== 'goo.gl' && host !== 'g.co') {
    return null;
  }
  return resolveShortLink(url.toString());
}

/**
 * Short-link expansion: follow redirects manually so we can read the final
 * URL (native `fetch` with `redirect: 'follow'` hides intermediate Location
 * headers from us). Google's share links usually redirect 302 → the canonical
 * google.com/maps/... URL which our parser handles.
 */
async function resolveShortLink(url: string): Promise<ParsedCoords | null> {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetchWithTimeout(current, { method: 'GET', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      const parsed = parseCoords(current);
      if (parsed) return parsed;
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      const fromBody = extractCoordsFromHtml(text, current);
      if (fromBody) return fromBody;
      // Page resolved but carried no coordinates (common for EU consent
      // interstitials and place pages that only render coords via JS). Fall
      // back to geocoding the place name Google embedded in the page.
      const name = extractPlaceNameFromHtml(text);
      if (name) {
        const geo = await geocodeName(name, url);
        if (geo) return geo;
      }
    }
    break;
  }
  return null;
}

/**
 * Pull coordinates out of a Google Maps HTML page. Checks (in order): the
 * canonical / og:url link, then the `!3d<lat>!4d<lng>` blob Google embeds in
 * place pages, then a bare `@lat,lng` in the body. The latter two catch links
 * whose canonical tag carries the place name but not the coords.
 */
function extractCoordsFromHtml(html: string, sourceUrl: string): ParsedCoords | null {
  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (canonicalMatch) {
    const parsed = parseCoords(canonicalMatch);
    if (parsed) return { ...parsed, source_url: sourceUrl };
  }

  const bang = html.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) {
    const lat = parseFloat(bang[1]);
    const lng = parseFloat(bang[2]);
    if (inWorldRange(lat, lng)) {
      return { lat, lng, name: extractPlaceNameFromHtml(html), source: 'google_maps', source_url: sourceUrl };
    }
  }

  const at = html.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lng = parseFloat(at[2]);
    if (inWorldRange(lat, lng)) {
      return { lat, lng, name: extractPlaceNameFromHtml(html), source: 'google_maps', source_url: sourceUrl };
    }
  }

  return null;
}

function inWorldRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    // Reject the 0,0 null-island artifact that some shells emit.
    !(lat === 0 && lng === 0)
  );
}

/** Extract the place name from og:title or <title>, stripping the Google suffix. */
function extractPlaceNameFromHtml(html: string): string | undefined {
  const raw =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/\s*[-–|·]\s*Google\s*Maps.*$/i, '')
    .replace(/&amp;/g, '&')
    .trim();
  return cleaned || undefined;
}

/** Geocode a place name extracted from a resolved-but-coordless Maps page. */
async function geocodeName(name: string, sourceUrl: string): Promise<ParsedCoords | null> {
  const result = await geocodePlace(name);
  if (result.status !== 'resolved') return null;
  // Only trust a precise or city-level hit — a country centroid is too coarse
  // to drop a pin on.
  if (result.match.granularity === 'area' || result.match.granularity === 'country') return null;
  return {
    lat: result.match.lat,
    lng: result.match.lng,
    name: result.match.label,
    source: 'google_maps',
    source_url: sourceUrl,
  };
}
