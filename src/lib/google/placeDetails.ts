/**
 * Place Details (New) for ONE field: a place's `displayName`.
 *
 * WHY THIS EXISTS (Sam, 2026-11-11). A fuel stop shows "Fuel stop · 89 km"
 * because Google's Maps Platform terms (§3.2.3) forbid caching business names:
 * Finn stores only the `place_id` (see `src/lib/forcedStopReason.ts`). The
 * station's name is fetched fresh, by that id, when the driver ASKS for it —
 * a tap — and is never written anywhere: not a column, not a log line, not a
 * cache (`stationNameGuard.test.ts`).
 *
 * The field mask is exactly `displayName`. That makes it a Place Details Pro
 * call ($17 / 1,000 after 5,000 free a month). Any wider mask costs more and
 * returns things nobody asked for.
 *
 * Raw client: the ONLY caller is `fetchPlaceDisplayNameAccounted` in
 * `server/google/accounted.ts`, which logs the spend
 * (`googleAccountingGuard.test.ts`). Throws on any failure — the caller decides
 * how to surface it; never returns a blank.
 */

export const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places/';
export const PLACE_NAME_FIELD_MASK = 'displayName';

/**
 * What a Google place id looks like. It goes into a URL PATH, so anything else
 * is refused before a request is built.
 */
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

export function isPlaceId(raw: unknown): raw is string {
  return typeof raw === 'string' && PLACE_ID_RE.test(raw);
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface PlaceDetailsDeps {
  fetchImpl?: FetchLike;
  apiKey?: string;
}

function serverApiKey(): string | undefined {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || undefined;
}

/** The place's display name. Throws on a bad id, no key, HTTP error, bad JSON or no name. */
export async function fetchPlaceDisplayName(placeId: string, deps?: PlaceDetailsDeps): Promise<string> {
  if (!isPlaceId(placeId)) throw new Error('fetchPlaceDisplayName: not a place id');
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const apiKey = deps?.apiKey ?? serverApiKey();
  if (!apiKey) throw new Error('No Google Maps API key configured.');

  const res = await fetchImpl(`${PLACE_DETAILS_URL}${encodeURIComponent(placeId)}`, {
    method: 'GET',
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_NAME_FIELD_MASK },
  });
  if (!res.ok) throw new Error(`Place details failed: HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error('Place details returned non-JSON');
  }
  const text = (json as { displayName?: { text?: unknown } } | null)?.displayName?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Place details returned no name');
  return text.trim();
}
