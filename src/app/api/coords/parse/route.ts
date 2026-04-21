import { z } from 'zod';
import { requireUserId, errorResponse, HttpError } from '@/server/auth/guards';
import { parseCoords, needsServerResolution, type ParsedCoords } from '@/lib/coords';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ input: z.string().min(1).max(2000) });

/**
 * Client-first coordinate parser with a server-side fallback for URL shapes
 * that require a network round trip:
 *
 *   - maps.app.goo.gl / goo.gl / g.co short links  → follow redirects, then
 *     re-parse the canonical URL with the pure client parser.
 *   - ioverlander.com/places/{id}-name             → fetch HTML, extract lat
 *     and lng from the page's embedded leaflet config or <meta> tags.
 *   - park4night.com/en/place/{id}-name            → same approach.
 *
 * Auth is required so anonymous scrapers can't turn this into a URL-expansion
 * proxy. Keeping the timeout short (5s) and the response small (just a lat/lng
 * pair + optional name) bounds the blast radius.
 */
export async function POST(request: Request) {
  try {
    await requireUserId();
    const { input } = schema.parse(await request.json());

    const direct = parseCoords(input);
    if (direct) return Response.json(direct);

    if (!needsServerResolution(input)) {
      return Response.json({ error: 'Could not parse coordinates from input.' }, { status: 400 });
    }

    const resolved = await resolveUrl(input);
    if (!resolved) {
      return Response.json(
        { error: 'Could not resolve coordinates from that URL.' },
        { status: 422 }
      );
    }
    return Response.json(resolved);
  } catch (err) {
    return errorResponse(err);
  }
}

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // Some hosts block default fetch UA. A browser-ish UA is enough to get
        // past the lazy checks without triggering CAPTCHAs.
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

async function resolveUrl(input: string): Promise<ParsedCoords | null> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co') {
    return resolveShortLink(url.toString());
  }
  if (host.endsWith('ioverlander.com')) {
    return scrapeIOverlander(url.toString());
  }
  if (host.endsWith('park4night.com')) {
    return scrapePark4Night(url.toString());
  }
  return null;
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
    // No redirect — try parsing the body (Google sometimes returns an HTML
    // page with a meta refresh or a canonical link).
    if (res.ok) {
      const text = await res.text();
      const fromBody = extractCoordsFromHtml(text, current);
      if (fromBody) return fromBody;
    }
    break;
  }
  return null;
}

async function scrapeIOverlander(url: string): Promise<ParsedCoords | null> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new HttpError(502, `iOverlander fetch failed: ${res.status}`);
  }
  const html = await res.text();
  const coords = extractCoordsFromHtml(html, url, 'ioverlander');
  return coords;
}

async function scrapePark4Night(url: string): Promise<ParsedCoords | null> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new HttpError(502, `Park4Night fetch failed: ${res.status}`);
  }
  const html = await res.text();
  const coords = extractCoordsFromHtml(html, url, 'park4night');
  return coords;
}

/**
 * Heuristic HTML coordinate extraction. We look for, in order:
 *   1. <meta property="place:location:latitude" content="..."> (OpenGraph)
 *   2. <meta name="geo.position" content="lat;lng">
 *   3. `"latitude":12.34,"longitude":56.78` JSON fragments (schema.org /
 *      leaflet config)
 *   4. `L.marker([lat, lng])` / `setView([lat, lng]` leaflet calls
 *   5. Any lat/lng-looking pair inside a `data-lat` / `data-lng` attribute.
 */
function extractCoordsFromHtml(
  html: string,
  sourceUrl: string,
  source?: ParsedCoords['source']
): ParsedCoords | null {
  const name = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
    .replace(/\s*[-|·•]\s*(iOverlander|Park4Night|Google Maps).*$/i, '')
    .trim() || undefined;

  const candidates: Array<[RegExp, number, number]> = [
    [
      /<meta\s+property=["']place:location:latitude["']\s+content=["'](-?\d+(?:\.\d+)?)["'][\s\S]*?<meta\s+property=["']place:location:longitude["']\s+content=["'](-?\d+(?:\.\d+)?)["']/i,
      1,
      2,
    ],
    [/<meta[^>]*name=["']geo\.position["'][^>]*content=["'](-?\d+(?:\.\d+)?)[;,\s]+(-?\d+(?:\.\d+)?)["']/i, 1, 2],
    [/"latitude"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i, 1, 2],
    [/L\.marker\(\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i, 1, 2],
    [/setView\(\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i, 1, 2],
    [/data-lat(?:itude)?=["'](-?\d+(?:\.\d+)?)["'][\s\S]{0,200}?data-l(?:ng|on|ongitude)=["'](-?\d+(?:\.\d+)?)["']/i, 1, 2],
  ];

  for (const [regex, latGroup, lngGroup] of candidates) {
    const m = html.match(regex);
    if (!m) continue;
    const lat = parseFloat(m[latGroup]);
    const lng = parseFloat(m[lngGroup]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng, name, source: source ?? 'manual', source_url: sourceUrl };
    }
  }

  // Last resort: a canonical or og:url link that happens to include coords.
  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (canonicalMatch) {
    const parsed = parseCoords(canonicalMatch);
    if (parsed) return { ...parsed, source: source ?? parsed.source, source_url: sourceUrl };
  }

  return null;
}
