import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { parseCoords, needsServerResolution, type ParsedCoords } from '@/lib/coords';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ input: z.string().min(1).max(2000) });

/**
 * Client-first coordinate parser with a server-side fallback for the only
 * URL shape that still needs redirect resolution: Google's Maps share
 * short links (maps.app.goo.gl / goo.gl / g.co). We follow redirects
 * manually so we can read the Location header of the canonical
 * google.com/maps/... URL and re-parse it with the pure client parser.
 *
 * iOverlander and Park4Night HTML scraping was intentionally removed: the
 * UX of pasting one of those URLs was brittle (pages redirect through
 * login walls on mobile, the HTML shape changes) and scraping their site
 * is uncomfortably close to their terms of service. Users paste raw
 * lat/lng from those apps now.
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

/**
 * HTML coord extraction, currently used only by the short-link fallback
 * when Google returns a full HTML page instead of a 30x redirect (happens
 * when the short link points at a place preview rather than a coord URL).
 * Kept minimal — just enough to surface coords from Google's own canonical
 * <link> / og:url when they include them.
 */
function extractCoordsFromHtml(html: string, sourceUrl: string): ParsedCoords | null {
  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (canonicalMatch) {
    const parsed = parseCoords(canonicalMatch);
    if (parsed) return { ...parsed, source_url: sourceUrl };
  }
  return null;
}
