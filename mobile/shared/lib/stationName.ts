/**
 * The station-name lookup's contract (`GET /api/stops/:id/place-name`), shared
 * by both stop cards. The name is fetched on a tap and never stored — see
 * `src/lib/google/placeDetails.ts` and `stationNameGuard.test.ts`.
 * DOM-free; mirrored to mobile/shared by sync-shared.
 */
import { formatKm, type UnitsPref } from '../lib/units';

export const STATION_NAME_UNAVAILABLE = 'station_name_unavailable';
export const STATION_NAME_CAP_REACHED = 'station_name_cap_reached';

export function stationNamePath(stopId: string): string {
  return `/api/stops/${encodeURIComponent(stopId)}/place-name`;
}

/** "Repsol Librilla A-7 · 89 km" — the name in place of "Fuel stop", distance kept. */
export function namedFuelStopLabel(
  name: string,
  distanceKm: number | null | undefined,
  units: UnitsPref,
): string {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return name;
  return `${name} · ${formatKm(distanceKm, units)}`;
}

/**
 * The line a card shows when the lookup fails. The label stays "Fuel stop ·
 * N km" either way — never a blank — and this says why the name is missing.
 */
export function stationNameErrorCopy(code: string | null | undefined): string {
  return code === STATION_NAME_CAP_REACHED
    ? "Station names are paused until tomorrow — today's limit is used."
    : "Couldn't load the station name.";
}

/** A card's per-stop state while it is open. Never persisted. */
export type StationNameState =
  | { status: 'loading' }
  | { status: 'ok'; name: string }
  | { status: 'failed'; message: string };

/**
 * Fetch one station's name for a card. Never throws and never yields a blank:
 * any failure — network, 4xx/5xx, a body without a name — becomes `failed`
 * with the line the card shows under the unchanged "Fuel stop · N km" label.
 * The caller keeps the result in component state only.
 */
export async function loadStationName(
  fetchJson: (path: string) => Promise<unknown>,
  stopId: string,
): Promise<StationNameState> {
  try {
    const body = (await fetchJson(stationNamePath(stopId))) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    return name
      ? { status: 'ok', name }
      : { status: 'failed', message: stationNameErrorCopy(null) };
  } catch (err) {
    const code = (err as { payload?: { code?: unknown } } | null)?.payload?.code;
    return { status: 'failed', message: stationNameErrorCopy(typeof code === 'string' ? code : null) };
  }
}
