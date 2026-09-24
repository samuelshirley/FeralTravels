/**
 * The one line a forced fuel stop carries on both clients' stop cards.
 *
 * Finn persists WHY he forced a stop as data (`stops.forced_reason`), never as
 * a sentence, so the distance can be worded in the driver's units here — the
 * English it replaced was baked with "km" on the server, which an imperial
 * user must never see. DOM-free; mirrored to mobile/shared by sync-shared.
 */
import type { ForcedStopReason, StopType } from '../types/trip';
import { formatKm, type UnitsPref } from '../lib/units';

/**
 * "Top up here: next fuel is 412 km away" / "…256 mi away", or null when there
 * is nothing to say: not a fuel stop, not forced, or a reason this client does
 * not know how to word (a newer server's kind is hidden, not mis-rendered).
 */
export function forcedStopLine(
  stopType: StopType,
  reason: ForcedStopReason | null | undefined,
  units: UnitsPref
): string | null {
  if (stopType !== 'fuel' || !reason) return null;
  if (reason.kind !== 'next_fuel_far' || !Number.isFinite(reason.gap_km)) return null;
  return `Top up here: next fuel is ${formatKm(reason.gap_km, units)} away`;
}
