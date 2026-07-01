/**
 * OSM Overpass client — Finn's station-data source.
 *
 * Why OSM and not Google Places: stations found here are **stored** in the
 * `stops` cache, and Google's ToS forbids persisting their place data. OSM is
 * ODbL — free to keep and redistribute *with attribution*. See
 * `docs/design/finn-fuel-agent.md` (Data-source split).
 *
 * This module is intentionally pure + injectable:
 *   - `buildFuelCorridorQuery` turns a route polyline into an Overpass QL string
 *   - `parseOverpassFuel` turns an Overpass JSON response into typed stations
 *   - `fetchFuelCorridor` wires them together over an injectable `fetch`
 *
 * Keep it dependency-light and side-effect-free apart from the one network call,
 * so the QL builder and parser are unit-testable without hitting the network.
 */

import { haversineKm, polylineLengthKm, type LatLng } from '@/lib/polyline';

/** Public Overpass instance. Swap for a hosted/self-run endpoint before scale. */
export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Identifying User-Agent for Overpass calls. REQUIRED — overpass-api.de rejects
 * User-Agent-less requests with HTTP 406, and OSM's usage policy mandates an
 * identifying agent with contact info. Do NOT remove this; a UA-less request
 * fails 100% of the time (this was the "finn:fuel-plan HTTP 406" prod outage).
 */
export const OVERPASS_USER_AGENT = 'FeralTravels/1.0 (+https://feraltravels.app; contact: samuelashirley@gmail.com)';

/**
 * A fuel station (or motorway service area) as stored from OSM. ODbL-licensed —
 * display OSM attribution wherever this is shown.
 */
export interface OsmFuelStation {
  /** Stable OSM identity, e.g. `"node/1234"` or `"way/5678"`. */
  osmId: string;
  lat: number;
  lng: number;
  name: string | null;
  brand: string | null;
  /**
   * True when this came from `highway=services` (a motorway service area) rather
   * than a plain `amenity=fuel` node. Motorway services are ~zero-detour but
   * often the priciest fuel — Finn's scoring, not this flag, decides.
   */
  isMotorwayServices: boolean;
  /** Raw OSM tags — kept for downstream `fuel:*` type matching and attribution. */
  tags: Record<string, string>;
}

export interface CorridorQueryOptions {
  /** Search buffer around the route, meters. Default 2000. */
  bufferMeters?: number;
  /**
   * Max coordinates embedded in the `around` filter. Overpass slows with very
   * long linestrings, so we downsample the polyline to at most this many points.
   * Default 200.
   */
  maxCoords?: number;
  /** Overpass server-side timeout, seconds (embedded in the QL). Default 50. */
  timeoutSec?: number;
}

interface ResolvedOptions {
  bufferMeters: number;
  maxCoords: number;
  timeoutSec: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  bufferMeters: 2000,
  maxCoords: 200,
  timeoutSec: 50,
};

function resolveOptions(opts: CorridorQueryOptions | undefined): ResolvedOptions {
  return {
    bufferMeters: opts?.bufferMeters ?? DEFAULT_OPTIONS.bufferMeters,
    maxCoords: opts?.maxCoords ?? DEFAULT_OPTIONS.maxCoords,
    timeoutSec: opts?.timeoutSec ?? DEFAULT_OPTIONS.timeoutSec,
  };
}

/**
 * Downsample a polyline by distance so embedded `around` centers are spaced no
 * more than `stepKm` apart. Always keeps the first and last vertices. Linear in
 * the number of vertices.
 */
export function downsampleByDistanceKm(polyline: LatLng[], stepKm: number): LatLng[] {
  if (polyline.length === 0) return [];
  if (polyline.length === 1 || stepKm <= 0) return [polyline[0]];

  const out: LatLng[] = [polyline[0]];
  let sinceLast = 0;
  for (let i = 1; i < polyline.length; i++) {
    sinceLast += haversineKm(polyline[i - 1], polyline[i]);
    const isLast = i === polyline.length - 1;
    if (sinceLast >= stepKm || isLast) {
      out.push(polyline[i]);
      sinceLast = 0;
    }
  }
  return out;
}

/**
 * Build the Overpass QL for "all fuel stations / motorway service areas within
 * `bufferMeters` of this route."
 *
 * Coverage note: the `around` filter draws a circle of radius `buffer` around
 * each embedded coordinate, so to leave no gaps the spacing between coordinates
 * must be ≤ 2·buffer. We downsample to satisfy `maxCoords`, then widen the
 * effective buffer if that downsampling would otherwise open holes — a contiguous
 * corridor matters more than a perfectly tight one (detour filtering refines
 * later). The widening is reported back so callers/tests can assert it.
 */
export function buildFuelCorridorQuery(
  polyline: LatLng[],
  opts?: CorridorQueryOptions
): { query: string; coordCount: number; effectiveBufferMeters: number } {
  if (polyline.length < 2) {
    throw new Error('buildFuelCorridorQuery: need at least 2 polyline points');
  }
  const { bufferMeters, maxCoords, timeoutSec } = resolveOptions(opts);

  const totalKm = polylineLengthKm(polyline);
  // Step that satisfies maxCoords, but never finer than the buffer (no point
  // embedding coordinates closer together than the circles already overlap).
  const stepKm = Math.max(bufferMeters / 1000, totalKm / Math.max(1, maxCoords));
  const coords = downsampleByDistanceKm(polyline, stepKm);

  // Guarantee contiguous coverage: buffer must reach at least halfway across the
  // gap between consecutive embedded centers.
  const effectiveBufferMeters = Math.max(bufferMeters, Math.round((stepKm * 1000) / 2));

  const coordStr = coords.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(',');
  const around = `around:${effectiveBufferMeters},${coordStr}`;

  const query =
    `[out:json][timeout:${timeoutSec}];\n` +
    `(\n` +
    `  nwr["amenity"="fuel"](${around});\n` +
    `  nwr["highway"="services"](${around});\n` +
    `);\n` +
    `out center tags;`;

  return { query, coordCount: coords.length, effectiveBufferMeters };
}

// ── Parsing ────────────────────────────────────────────────────────────────

interface RawOverpassElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: unknown;
  tags?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asStringTags(v: unknown): Record<string, string> {
  const rec = asRecord(v);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/** Pull lat/lng from a node (`lat`/`lon`) or a way/relation (`center`). */
function coordsOf(el: RawOverpassElement): { lat: number; lng: number } | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lng: el.lon };
  }
  const center = asRecord(el.center);
  if (center && typeof center.lat === 'number' && typeof center.lon === 'number') {
    return { lat: center.lat, lng: center.lon };
  }
  return null;
}

/**
 * Parse an Overpass JSON response into typed fuel stations. Malformed or
 * coordinate-less elements are skipped rather than thrown (one bad element
 * shouldn't sink a whole corridor). Deduplicates by `osmId`.
 */
export function parseOverpassFuel(json: unknown): OsmFuelStation[] {
  const root = asRecord(json);
  const elements = root?.elements;
  if (!Array.isArray(elements)) return [];

  const byId = new Map<string, OsmFuelStation>();
  for (const raw of elements) {
    const el = asRecord(raw) as RawOverpassElement | null;
    if (!el) continue;
    if (typeof el.type !== 'string' || typeof el.id !== 'number') continue;

    const coords = coordsOf(el);
    if (!coords) continue;

    const tags = asStringTags(el.tags);
    const osmId = `${el.type}/${el.id}`;
    const isMotorwayServices = tags['highway'] === 'services';

    // Skip service areas that aren't actually fuel-bearing AND aren't tagged as
    // fuel — but keep them when explicitly highway=services (they usually have
    // fuel; the detour/price stage can drop a dud).
    const isFuel = tags['amenity'] === 'fuel';
    if (!isFuel && !isMotorwayServices) continue;

    byId.set(osmId, {
      osmId,
      lat: coords.lat,
      lng: coords.lng,
      name: tags['name'] ?? null,
      brand: tags['brand'] ?? null,
      isMotorwayServices,
      tags,
    });
  }
  return [...byId.values()];
}

// ── Fetch ────────────────────────────────────────────────────────────────

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface FetchCorridorDeps {
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Override the Overpass endpoint. */
  endpoint?: string;
}

/**
 * Run a corridor query against Overpass and return stations. Throws on transport
 * or server error — Finn's caller decides how to surface it (never swallowed).
 */
export async function fetchFuelCorridor(
  polyline: LatLng[],
  opts?: CorridorQueryOptions,
  deps?: FetchCorridorDeps
): Promise<OsmFuelStation[]> {
  const { query } = buildFuelCorridorQuery(polyline, opts);
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) throw new Error('fetchFuelCorridor: no fetch implementation available');
  const endpoint = deps?.endpoint ?? DEFAULT_OVERPASS_ENDPOINT;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass returns HTTP 406 without an identifying User-Agent (see const).
      'User-Agent': OVERPASS_USER_AGENT,
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) {
    throw new Error(`Overpass request failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Overpass returned non-JSON response');
  }
  return parseOverpassFuel(json);
}
