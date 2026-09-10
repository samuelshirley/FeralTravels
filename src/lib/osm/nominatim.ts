import 'server-only';

/**
 * Server-side reverse geocoding: coordinates → a place name a driver recognises.
 *
 * WHY THIS EXISTS. `get_route` splits a long drive into daily segments and hands
 * Penny the split points as bare lat/lng. She then has to call them something,
 * and being a language model she invents one — trip `ab824cde` (2026-09-09) has
 * "Texas Panhandle" and "Albuquerque area", neither of which is a place you can
 * navigate to. CLAUDE.md's rule is that the LLM converts and does not author; a
 * coordinate's name is a fact, so the server owes her the answer.
 *
 * WHY NOT GOOGLE. There is exactly one Google key and the Geocoding API is NOT
 * enabled on it — probed 2026-09-09, `REQUEST_DENIED`, "not authorized to use
 * this service", the same shape as the outage CLAUDE.md records for the legacy
 * Places SKU. Places (New) `searchText` is enabled but answers the opposite
 * question (name → coords).
 *
 * NOMINATIM'S TERMS ARE THE DESIGN CONSTRAINTS, not suggestions:
 *   - an identifying User-Agent is MANDATORY; requests without one are refused
 *   - at most 1 request per second, which is why this module serialises
 *   - it is a free community service, so treat every failure as expected and
 *     never let it fail a plan — a missing name degrades to Penny's own words,
 *     which is exactly where we were before.
 *
 * See https://operations.osmfoundation.org/policies/nominatim/
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Identifies us to Nominatim. Their policy requires a real contact point; an
 * anonymous or spoofed UA is how a project gets blocked. Overridable so a
 * deployment can name itself.
 */
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  'FeralTravels/1.0 (+https://www.feraltravels.com)';

/** Their published limit. One in flight, at most one per second. */
const MIN_INTERVAL_MS = 1_100;
const TIMEOUT_MS = 4_000;

/**
 * `zoom=10` is city/town granularity. Higher zooms return a street address,
 * which is wrong for "where does day 3 end" — a driver wants a town, not a
 * house number.
 */
const ZOOM = 10;

/** Serialises callers so the 1 req/s limit holds even under a batch of splits. */
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

export interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
}

/**
 * The best short label for a point: "Amarillo, Texas" — the town a driver would
 * recognise, qualified enough to be unambiguous. Null when Nominatim has nothing
 * usable, which the caller must treat as "no name", never as an error.
 */
export function formatPlaceLabel(
  name: string | null | undefined,
  address: NominatimAddress | null | undefined
): string | null {
  const a = address ?? {};
  const locality =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? name ?? a.county ?? null;
  if (!locality) return null;

  // Qualify with the state (US/AU/etc.) where there is one, else the country.
  // A bare "Amarillo" is a worse answer than the model's guess on a trip that
  // crosses borders.
  const qualifier = a.state ?? a.country ?? null;
  if (!qualifier || qualifier === locality) return locality;
  return `${locality}, ${qualifier}`;
}

/**
 * Reverse-geocode one point. Never throws: every failure mode — no network, a
 * timeout, a 4xx, unparseable JSON, a point in the ocean — returns null, because
 * a missing split-point name must never be able to fail a trip plan.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const run = async (): Promise<string | null> => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();

    const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=${ZOOM}&addressdetails=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { name?: string; address?: NominatimAddress };
      return formatPlaceLabel(json.name, json.address);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const result = queue.then(run, run);
  // Keep the chain alive whatever happens, so one failure cannot wedge the queue.
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
