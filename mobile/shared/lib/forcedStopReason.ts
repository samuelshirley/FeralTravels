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
 * "Top up here: next fuel is 412 km away" / "…256 mi away" — with ", on the
 * next day's drive" when the stop is for tomorrow's first stretch — or null
 * when there is nothing to say: not a fuel stop, not forced, or a reason this
 * client does not know how to word (a newer server's kind is hidden, not
 * mis-rendered).
 */
export function forcedStopLine(
  stopType: StopType,
  reason: ForcedStopReason | null | undefined,
  units: UnitsPref
): string | null {
  if (stopType !== 'fuel' || !reason || !Number.isFinite(reason.gap_km)) return null;
  const line = `Top up here: next fuel is ${formatKm(reason.gap_km, units)} away`;
  switch (reason.kind) {
    case 'next_fuel_far':
      return line;
    case 'next_day_fuel_far':
      return `${line}, on the next day's drive`;
    default:
      return null;
  }
}

/**
 * What VoiceOver reads for one row of a day's stop timeline — and so what the
 * iOS e2e flows can match.
 *
 * The row is a Google Maps link, and an explicit `accessibilityLabel` HIDES a
 * control's children: the label that was here, "<name> in Google Maps", was all
 * a screen-reader user heard. The kicker, the distance and — the one CLAUDE.md
 * makes mandatory — Finn's reason for forcing the stop were on screen and
 * nowhere else. So the label carries every line the row shows, in the same
 * units, and still says where the tap goes.
 *
 * "FUEL: TotalEnergies Château-Thierry, 95 km. Top up here: next fuel is 412 km
 * away, on the next day's drive. Opens in Google Maps"
 */
export function stopRowAccessibilityLabel(
  row: { kicker: string; name: string; distanceKm: number | null; forcedLine: string | null },
  units: UnitsPref
): string {
  const head =
    row.distanceKm != null
      ? `${row.kicker}: ${row.name}, ${formatKm(row.distanceKm, units)}.`
      : `${row.kicker}: ${row.name}.`;
  return [head, row.forcedLine ? `${row.forcedLine}.` : null, 'Opens in Google Maps']
    .filter(Boolean)
    .join(' ');
}
