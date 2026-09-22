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

/**
 * Nominatim answers in the LOCAL language unless told otherwise, so an
 * un-parameterised request labelled a Spanish split point "Girona, Catalunya"
 * and an Italian one "Modena, Italia" — captured, both of them, in
 * `__fixtures__/nominatim-reverse.json` under the `_no_accept_language` keys.
 * The itinerary is written in English, so the place names in it are too.
 */
const ACCEPT_LANGUAGE = 'en';

/**
 * The exact request we send. Exported ONLY so a test can assert its shape:
 * `addressdetails` and `accept-language` are both load-bearing and both
 * invisible in the response when they go missing — without addressdetails there
 * is no locality at all, and without accept-language Nominatim answers in the
 * local language ("Modena, Italia").
 */
export function reverseUrl(lat: number, lng: number): string {
  return (
    `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=${ZOOM}` +
    `&addressdetails=1&accept-language=${ACCEPT_LANGUAGE}`
  );
}

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
 * How big the settlement at a coordinate is, straight from which key Nominatim
 * put the name under. Ordered: a `city` is a better place to end a driving day
 * than a `hamlet`, and `none` means there is no settlement there at all.
 *
 * This is the whole input to the split-point snap in
 * `lib/penny/splitPointNames.ts` — see that file for what it does with it.
 */
export type SettlementRank = 'city' | 'town' | 'village' | 'hamlet' | 'none';

const RANK_ORDER: readonly SettlementRank[] = ['city', 'town', 'village', 'hamlet', 'none'];

/** True when `a` is at least as substantial a settlement as `b`. */
export function rankAtLeast(a: SettlementRank, b: SettlementRank): boolean {
  return RANK_ORDER.indexOf(a) <= RANK_ORDER.indexOf(b);
}

/** Which settlement key carried the name, if any. */
export function settlementRank(address: NominatimAddress | null | undefined): SettlementRank {
  const a = address ?? {};
  if (a.city) return 'city';
  if (a.town) return 'town';
  if (a.village) return 'village';
  if (a.hamlet) return 'hamlet';
  return 'none';
}

/**
 * The countries where the sub-national unit is what a person actually says.
 *
 * "Amarillo, Texas" is how it is said; "Tavel, Occitania" is not, and that is
 * the bug this set exists to fix — `address.state` in France is the *région*,
 * so a two-day Girona→Annecy plan read "Girona → Tavel, Occitania" and
 * "Tavel, Occitania → Annecy, Auvergne-Rhône-Alpes" (reported 2026-09-21).
 * The old rule was `state ?? country`, written and tested entirely against US
 * payloads.
 *
 * Deliberately a SHORT allowlist of federal countries whose states/provinces
 * are the everyday qualifier, not a guess at every country's administrative
 * culture. Everywhere else the country is the qualifier a driver wants, and
 * being wrong that way just reads as plain ("Tavel, France").
 */
const STATE_QUALIFIER_COUNTRIES: ReadonlySet<string> = new Set([
  'us', // Texas
  'ca', // British Columbia
  'au', // Queensland
  'br', // Minas Gerais
  'mx', // Jalisco
  'in', // Kerala
]);

/**
 * The best short label for a point: "Amarillo, Texas", "Tavel, France" — the
 * town a driver would recognise, qualified enough to be unambiguous. Null when
 * Nominatim has nothing usable, which the caller must treat as "no name", never
 * as an error.
 */
export function formatPlaceLabel(
  name: string | null | undefined,
  address: NominatimAddress | null | undefined
): string | null {
  const a = address ?? {};
  const locality =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? name ?? a.county ?? null;
  if (!locality) return null;

  // A bare "Amarillo" is a worse answer than the model's guess on a trip that
  // crosses borders, so there is always a qualifier when one is available.
  const cc = a.country_code?.toLowerCase();
  const qualifier = (cc && STATE_QUALIFIER_COUNTRIES.has(cc) ? a.state ?? a.country : a.country ?? a.state) ?? null;

  if (!qualifier || qualifier === locality) return locality;
  return `${locality}, ${qualifier}`;
}

/** A resolved point: what to call it, and how big a place it is. */
export interface PlaceLookup {
  label: string | null;
  rank: SettlementRank;
}

/**
 * Reverse-geocode one point. Never throws: every failure mode — no network, a
 * timeout, a 4xx, unparseable JSON, a point in the ocean — returns a null label
 * and rank `none`, because a missing split-point name must never be able to
 * fail a trip plan.
 */
export async function lookupPlace(lat: number, lng: number): Promise<PlaceLookup> {
  const empty: PlaceLookup = { label: null, rank: 'none' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return empty;

  const run = async (): Promise<PlaceLookup> => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();

    const url = reverseUrl(lat, lng);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return empty;
      const json = (await res.json()) as { name?: string; address?: NominatimAddress };
      return {
        label: formatPlaceLabel(json.name, json.address),
        rank: settlementRank(json.address),
      };
    } catch {
      return empty;
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

/** The label alone, for callers that do not care how big the place is. */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  return (await lookupPlace(lat, lng)).label;
}
