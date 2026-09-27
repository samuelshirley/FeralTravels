import 'server-only';
import { parseCoords, needsServerResolution, type ParsedCoords } from '@/lib/coords';
import { geocodePlaceAccounted, type CallerRef } from '@/server/google/accounted';
import { logUsageEvent } from '@/server/repos/usage';

const FETCH_TIMEOUT_MS = 5000;
const MAX_MAPS_LINKS_PER_MESSAGE = 5;
/**
 * Redirect hops to follow. A 2026-09 share link takes THREE 302s before the
 * 200 (maps.app.goo.gl → maps.google.com?q= → maps.google.com/maps?q= →
 * www.google.com/maps?q=), so four fetches; one hop of headroom over the old 5.
 */
const MAX_HOPS = 6;
/** Paid Places lookups a single link may spend when the page carries no coords. */
const MAX_GEOCODE_ATTEMPTS = 2;

/**
 * User-Agent for short-link expansion. MUST be a crawler/social UA, NOT a
 * browser one. A browser UA (e.g. Safari) gets Google's JS-only app-link
 * interstitial for maps.app.goo.gl — no coords, no name, nothing extractable
 * server-side (this was the "links won't resolve" bug). A crawler UA makes
 * Google embed the real destination as an encoded `google.com/maps?q=<addr>`
 * link, which extractEmbeddedMapsQuery pulls out. Do NOT change back to a
 * browser UA without re-verifying interstitial resolution still works.
 */
const SHORT_LINK_USER_AGENT = 'facebookexternalhit/1.1 (+https://feraltravels.app)';

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
  /**
   * Unresolved links only: the place name / address the server DID recover
   * (og:title, the redirect's `q=`, or the page's embedded link) even though
   * it found no coordinates. Penny passes it to resolve_place once instead of
   * asking the user for something the link already told us.
   */
  name_hint?: string;
  /** Unresolved links only: where resolution stopped (see ResolveStage). */
  stage?: ResolveStage;
};

/** Where a link's resolution stopped. `http_<n>` is a non-2xx, non-redirect status. */
export type ResolveStage =
  | 'fetch_error'
  | `http_${number}`
  | 'no_coords'
  | 'geocode_miss'
  | 'redirect_limit';

/** Internal outcome of resolving one link — richer than ParsedCoords|null so a miss can be logged. */
type ResolveOutcome =
  | { ok: true; coords: ParsedCoords; via: 'url' | 'redirect' | 'page' | 'geocode'; hops: number }
  | { ok: false; stage: ResolveStage; hops: number; hint?: string; detail?: string };

/**
 * Resolve coordinates from user input — sync parse first, then short-link
 * redirect expansion for maps.app.goo.gl / goo.gl / g.co.
 */
export async function resolveCoordsFromInput(input: string): Promise<ParsedCoords | null> {
  const outcome = await resolveInput(input);
  return outcome.ok ? outcome.coords : null;
}

async function resolveInput(input: string, who: CallerRef = {}): Promise<ResolveOutcome> {
  const direct = parseCoords(input);
  if (direct) return { ok: true, coords: direct, via: 'url', hops: 0 };

  if (!needsServerResolution(input)) {
    return { ok: false, stage: 'no_coords', hops: 0, detail: 'not a coordinate URL or short link' };
  }

  return resolveShortLinkUrl(input.trim(), who);
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

/**
 * Record a link that did not resolve (or needed a paid lookup to) as a
 * `penny:maps-link` usage row, so it shows in /admin/errors. Fire-and-forget:
 * the log must never fail the turn it describes.
 */
function recordLinkOutcome(url: string, outcome: ResolveOutcome, who: CallerRef): void {
  let errorMessage: string;
  let success: boolean;
  if (outcome.ok) {
    if (outcome.via !== 'geocode') return;
    success = true;
    errorMessage = `via=geocode host=${hostOf(url)} hops=${outcome.hops} url=${url}`;
  } else {
    success = false;
    errorMessage =
      `stage=${outcome.stage} host=${hostOf(url)} hops=${outcome.hops} hint=${outcome.hint ? 'yes' : 'no'}` +
      (outcome.detail ? ` detail=${outcome.detail}` : '') +
      ` url=${url}`;
  }
  logUsageEvent({
    userId: who.userId ?? null,
    tripId: who.tripId ?? null,
    provider: 'penny:maps-link',
    requests: 0,
    success,
    errorMessage,
  }).catch((e) => console.warn('logUsageEvent (maps-link) failed:', e));
}

/**
 * Find Google/Apple Maps links in a chat message and resolve each to lat/lng.
 * Used by Penny replan to enrich the user turn before Claude sees it.
 */
export async function resolveMapsLinksInMessage(
  message: string,
  who: CallerRef = {},
): Promise<ResolvedMapsLink[]> {
  const urls = extractUrlsFromText(message).filter(looksLikeMapsUrl).slice(0, MAX_MAPS_LINKS_PER_MESSAGE);

  if (urls.length === 0) return [];

  const results = await Promise.all(
    urls.map(async (url): Promise<ResolvedMapsLink> => {
      let outcome: ResolveOutcome;
      try {
        outcome = await resolveInput(url, who);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[maps-link] resolving ${url} threw: ${detail}`);
        outcome = { ok: false, stage: 'fetch_error', hops: 0, detail };
      }
      recordLinkOutcome(url, outcome, who);

      if (outcome.ok) {
        const parsed = outcome.coords;
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
        stage: outcome.stage,
        error:
          outcome.stage === 'fetch_error'
            ? 'Failed to fetch or parse that URL.'
            : 'Could not resolve coordinates from that URL.',
        ...(outcome.hint ? { name_hint: outcome.hint } : {}),
      };
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
        // Crawler UA on purpose — see SHORT_LINK_USER_AGENT.
        'user-agent': SHORT_LINK_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveShortLinkUrl(input: string, who: CallerRef): Promise<ResolveOutcome> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, stage: 'no_coords', hops: 0, detail: 'invalid URL' };
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'maps.app.goo.gl' && host !== 'goo.gl' && host !== 'g.co') {
    return { ok: false, stage: 'no_coords', hops: 0, detail: 'not a short-link host' };
  }
  return resolveShortLink(url.toString(), who);
}

/** The `q=` of a redirect target, when it names a place rather than a lat,lng. */
function queryHintFromLocation(location: string): string | undefined {
  try {
    const q = new URL(location).searchParams.get('q')?.trim();
    if (!q || parseCoords(q)) return undefined;
    return q;
  } catch {
    return undefined;
  }
}

/**
 * Short-link expansion: follow redirects manually so we can read each
 * Location (native `fetch` with `redirect: 'follow'` hides them).
 *
 * Signals, in the order they are trusted:
 *   1. coords in a redirect Location (parseCoords);
 *   2. FREE coords on the final page (extractCoordsFromHtml) — canonical,
 *      `!3d!4d`, the og:image staticmap `markers=` then `center=`, body `@lat,lng`;
 *   3. PAID Places lookups (at most MAX_GEOCODE_ATTEMPTS) on the recovered
 *      names — Location `q=`, embedded link `q=`, og:description, og:title.
 *
 * NOT used: the `ftid=` in the Location — it is a feature id, not a Places
 * place_id, and Places cannot look it up. And NEVER the page's
 * `APP_INITIALIZATION_STATE`: that is the VIEWER's viewport (the server's
 * IP location), not the shared place.
 */
async function resolveShortLink(url: string, who: CallerRef): Promise<ResolveOutcome> {
  let current = url;
  let hint: string | undefined;
  let hops = 0;
  for (let i = 0; i < MAX_HOPS; i++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(current, { method: 'GET', redirect: 'manual' });
    } catch (err) {
      return {
        ok: false,
        stage: 'fetch_error',
        hops,
        hint,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, stage: `http_${res.status}`, hops, hint, detail: 'redirect without Location' };
      }
      hops++;
      current = new URL(loc, current).toString();
      const parsed = parseCoords(current);
      if (parsed) return { ok: true, coords: parsed, via: 'redirect', hops };
      hint = queryHintFromLocation(current) ?? hint;
      continue;
    }
    if (!res.ok) {
      return { ok: false, stage: `http_${res.status}`, hops, hint };
    }
    const html = normalizeHtml(await res.text());

    const pageTitle = extractPlaceNameFromHtml(html);
    const embeddedQuery = extractEmbeddedMapsQuery(html) ?? undefined;
    // The name we keep. og:title / the redirect's q= are what the user shared;
    // the embedded q= is usually "Name, full address" and yields to Places'
    // label when a lookup is needed.
    const sharedName = pageTitle ?? hint;
    const nameHint = sharedName ?? embeddedQuery;

    const free = extractCoordsFromHtml(html, current);
    if (free) {
      return {
        ok: true,
        coords: { ...free, name: sharedName ?? free.name ?? embeddedQuery },
        via: 'page',
        hops,
      };
    }

    // Some links use q=<lat,lng> in the embedded link — free, parse directly.
    if (embeddedQuery) {
      const asCoords = parseCoords(embeddedQuery);
      if (asCoords) {
        return { ok: true, coords: { ...asCoords, source: 'google_maps', source_url: url }, via: 'page', hops };
      }
    }

    const candidates = dedupe([hint, embeddedQuery, extractOgDescription(html), pageTitle]);
    if (candidates.length === 0) {
      return { ok: false, stage: 'no_coords', hops };
    }
    for (const candidate of candidates.slice(0, MAX_GEOCODE_ATTEMPTS)) {
      const geo = await geocodeName(candidate, url, who);
      if (geo) {
        return { ok: true, coords: { ...geo, name: sharedName ?? geo.name }, via: 'geocode', hops };
      }
    }
    return { ok: false, stage: 'geocode_miss', hops, hint: nameHint };
  }
  return { ok: false, stage: 'redirect_limit', hops, hint };
}

function dedupe(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t || isBareGoogleMaps(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Undo the escaping Google layers over its HTML so one set of regexes reads
 * every copy: JS-string `=` / `&` (the JSON blobs) and `&amp;`
 * (attribute values, e.g. the og:image staticmap URL).
 */
function normalizeHtml(html: string): string {
  return html
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&');
}

/** Latitude, longitude with at least 3 decimals — a staticmap parameter value. */
const STATICMAP_PAIR = String.raw`(-?\d{1,2}\.\d{3,})(?:%2C|,)(-?\d{1,3}\.\d{3,})`;
/** Optional marker-style prefix (`color:red%7Clabel:A%7C`) before the pair. */
const STATICMAP_STYLE = String.raw`(?:[^&"'\s<>]*?(?:%7C|\|))?`;

function staticmapParam(html: string, param: 'markers' | 'center'): { lat: number; lng: number } | null {
  const re = new RegExp(
    String.raw`staticmap\?[^"'\s<>]*?\b${param}=${param === 'markers' ? STATICMAP_STYLE : ''}${STATICMAP_PAIR}`,
    'i',
  );
  const m = html.match(re);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  return inWorldRange(lat, lng) ? { lat, lng } : null;
}

/**
 * Pull FREE coordinates out of a (normalised) Google Maps HTML page, in order:
 * the canonical / og:url link, the `!3d<lat>!4d<lng>` blob of place pages,
 * the og:image staticmap's `markers=` then `center=` (a 2026-09 share page
 * carries the place ONLY there), and last a bare `@lat,lng` in the body.
 * Never reads APP_INITIALIZATION_STATE — that is the viewer's viewport.
 */
function extractCoordsFromHtml(html: string, sourceUrl: string): ParsedCoords | null {
  const canonicalMatch =
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i)?.[1];
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

  const pin = staticmapParam(html, 'markers') ?? staticmapParam(html, 'center');
  if (pin) {
    return { ...pin, name: extractPlaceNameFromHtml(html), source: 'google_maps', source_url: sourceUrl };
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

const PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;

/**
 * Pull the destination query out of a Google Maps page.
 *
 * Google embeds it as an encoded link — `google.com/maps%3Fq%3D<value>%26ftid=…`
 * — where `<value>` uses `%2B` for spaces (e.g. a full address or place name),
 * or occasionally a bare `lat,lng`. A 2026-09 page double-encodes it inside a
 * sign-in `continue=` (`Pra%25C3%25A7a%2Bdo…`), so decoding repeats while a
 * `%XX` escape remains (max 3 passes). Handles both the encoded (`%3Fq%3D`)
 * and plain (`?q=`) forms. Returns the decoded query string, or null if absent.
 */
export function extractEmbeddedMapsQuery(html: string): string | null {
  const m =
    html.match(/google\.com\/maps%3Fq%3D(.+?)(?:%26|["'\\ ])/i) ||
    html.match(/google\.com\/maps\?q=([^&"'\\ ]+)/i);
  if (!m) return null;
  let value = m[1];
  try {
    for (let pass = 0; pass < 3; pass++) {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
      if (!PERCENT_ESCAPE_RE.test(value)) break;
    }
  } catch {
    // A malformed escape — keep what decoded cleanly so far.
  }
  const decoded = value.replace(/\+/g, ' ').trim();
  return decoded || null;
}

/** Decode the HTML entities Google emits in attribute values. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** A meta tag's content by property, in either attribute order. */
function metaProperty(html: string, property: string): string | undefined {
  const p = property.replace(/[.:]/g, (c) => `\\${c}`);
  const raw =
    html.match(new RegExp(`<meta[^>]+property=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${p}["']`, 'i'))?.[1];
  const value = raw === undefined ? undefined : decodeEntities(raw).trim();
  return value || undefined;
}

function isBareGoogleMaps(s: string): boolean {
  return /^google\s*maps$/i.test(s.trim());
}

function extractOgDescription(html: string): string | undefined {
  return metaProperty(html, 'og:description');
}

/**
 * The place name from og:title (either attribute order) or <title>, with the
 * " - Google Maps" suffix stripped. A bare "Google Maps" is the app's own
 * title, never a place name.
 */
function extractPlaceNameFromHtml(html: string): string | undefined {
  const candidates = [metaProperty(html, 'og:title'), html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]];
  for (const raw of candidates) {
    if (!raw) continue;
    const cleaned = decodeEntities(raw)
      .replace(/\s*[-–|·]\s*Google\s*Maps.*$/i, '')
      .trim();
    if (cleaned && !isBareGoogleMaps(cleaned)) return cleaned;
  }
  return undefined;
}

/** Geocode a place name extracted from a resolved-but-coordless Maps page. */
async function geocodeName(name: string, sourceUrl: string, who: CallerRef): Promise<ParsedCoords | null> {
  const result = await geocodePlaceAccounted(name, {}, who);
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
