import 'server-only';

import { z } from 'zod';

import type { BBox } from './anchor';

/**
 * OpenStreetMap / Overpass client for the overnight-stop engine.
 *
 * Why OSM, not Google: we store everything we query, and Google's Maps
 * Platform terms forbid persisting their content / building a derived
 * dataset. OSM is openly licensed (ODbL) — ours to keep. Google stays for
 * live routing only. See docs/overnight-stop-feature-scope.md.
 *
 * Public Overpass instances rate-limit and time out big queries — that's an
 * economics-of-free issue, not stale tech. We only ever query the small bbox
 * around one route's overnight window, so the query stays cheap. If scale
 * later demands it, self-host Overpass or import Geofabrik extracts into
 * Postgres; this module's interface stays the same.
 */

export type OsmCategory = 'parking' | 'park' | 'dog_park' | 'caravan_site' | 'fuel';

export interface OsmCandidate {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  lat: number;
  lng: number;
  category: OsmCategory;
  name: string | null;
  /** Raw OSM tags, kept for later ranking / display / debugging. */
  tags: Record<string, string>;
  /** tags.surface, if present (gravel/unpaved/asphalt/…). */
  surface: string | null;
  /** True when tags signal motorhome/overnight tolerance. */
  motorhomeFriendly: boolean;
}

export const OVERPASS_DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_QUERY_TIMEOUT_SEC = 25;
/**
 * Overpass etiquette requires an identifying User-Agent; requests without one
 * are rejected (HTTP 406). Identify the app and a contact point.
 */
const OVERPASS_USER_AGENT = 'trip-planner/1.0 (overland trip planner; +https://github.com/trip-planner)';

/**
 * OSM key/value selectors we pull for overnight planning. `fuel` is included
 * so the (future) fuel layer can reuse the same query; the overnight ranker
 * filters it out.
 */
export const OVERNIGHT_OSM_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ['amenity', 'parking'],
  ['leisure', 'park'],
  ['leisure', 'dog_park'],
  ['tourism', 'caravan_site'],
  ['amenity', 'fuel'],
] as const;

/**
 * Build an Overpass QL query for everything we care about inside a bbox.
 * `nwr` = nodes, ways and relations; `out center tags` gives a single
 * lat/lon for ways/relations plus their tags.
 */
export function buildOverpassQuery(
  bbox: BBox,
  queryTimeoutSec: number = DEFAULT_QUERY_TIMEOUT_SEC
): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const lines = OVERNIGHT_OSM_SELECTORS.map(
    ([k, v]) => `  nwr["${k}"="${v}"](${b});`
  ).join('\n');
  return `[out:json][timeout:${queryTimeoutSec}];\n(\n${lines}\n);\nout center tags;`;
}

const elementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string()).optional(),
});

const overpassResponseSchema = z.object({
  elements: z.array(elementSchema),
});

const MOTORHOME_YES = new Set(['yes', 'designated', 'permissive', 'customers']);

function categorize(tags: Record<string, string>): OsmCategory | null {
  // Priority order: the most specific / most useful category wins.
  if (tags.tourism === 'caravan_site') return 'caravan_site';
  if (tags.leisure === 'dog_park') return 'dog_park';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.leisure === 'park') return 'park';
  if (tags.amenity === 'fuel') return 'fuel';
  return null;
}

function isMotorhomeFriendly(tags: Record<string, string>): boolean {
  return (
    (tags.motorhome !== undefined && MOTORHOME_YES.has(tags.motorhome)) ||
    tags.overnight === 'yes' ||
    (tags.caravan !== undefined && MOTORHOME_YES.has(tags.caravan))
  );
}

/**
 * Parse a raw Overpass JSON response into typed candidates. Pure — unit
 * tested with fixtures. Elements with no derivable coordinate or no
 * recognised category are skipped.
 */
export function parseOverpassResponse(raw: unknown): OsmCandidate[] {
  const parsed = overpassResponseSchema.parse(raw);
  const candidates: OsmCandidate[] = [];

  for (const el of parsed.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;

    const tags = el.tags ?? {};
    const category = categorize(tags);
    if (category === null) continue;

    candidates.push({
      osmType: el.type,
      osmId: el.id,
      lat,
      lng,
      category,
      name: tags.name ?? null,
      tags,
      surface: tags.surface ?? null,
      motorhomeFriendly: isMotorhomeFriendly(tags),
    });
  }

  return candidates;
}

export interface FetchOverpassOptions {
  endpoint?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** POST a query to Overpass and return the parsed JSON (unvalidated). */
export async function fetchOverpass(
  query: string,
  options: FetchOverpassOptions = {}
): Promise<unknown> {
  const endpoint = options.endpoint ?? OVERPASS_DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller passed a signal, abort our controller when theirs fires.
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OVERPASS_USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: query → fetch → parse for one bbox. */
export async function findCandidatesInBBox(
  bbox: BBox,
  options: FetchOverpassOptions = {}
): Promise<OsmCandidate[]> {
  const query = buildOverpassQuery(bbox);
  const raw = await fetchOverpass(query, options);
  return parseOverpassResponse(raw);
}
