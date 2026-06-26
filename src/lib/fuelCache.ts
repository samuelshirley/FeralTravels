/**
 * Lazy fuel-cache freshness window.
 *
 * A leg's auto fuel stops are sourced lazily when the user first opens that day
 * (no eager trip-wide planning — that was the Google Places cost sink). Once
 * sourced, the result is cached against `legs.fuel_stops_updated_at`. Reopening
 * the same day within this window renders straight from cache with zero Places
 * calls; past it, the day-open loader re-checks.
 *
 * Lives in its own (non `server-only`) module so both the server planner
 * (`server/fuel.ts`) and the client day-open loader (`LegCard.tsx`) share one
 * source of truth for the window. 48h is the middle of the 24–72h band the
 * design doc proposed (see docs / CLAUDE.md MVP scope).
 */
export const FUEL_CACHE_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * True when a leg's cached fuel result is still fresh: it has a real search
 * timestamp and that timestamp is within `FUEL_CACHE_TTL_MS`. Callers also
 * gate on the leg being in a terminal-success fuel_status (`ready` /
 * `no_stations_found`) — a null/older timestamp means "re-check on open".
 */
export function isFuelCacheFresh(
  updatedAtISO: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!updatedAtISO) return false;
  const ts = Date.parse(updatedAtISO);
  if (Number.isNaN(ts)) return false;
  return now - ts < FUEL_CACHE_TTL_MS;
}
