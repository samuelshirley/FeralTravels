/**
 * Unit display helpers — client-safe (no `server-only` import).
 *
 * The DB stores everything in metric (km, kg, L). The user's `units_pref`
 * column on `users` is purely a display preference: we render km as the
 * primary label everywhere, and when the user has chosen imperial we render
 * a small secondary `(X mi)` line below it. Form inputs that show miles
 * convert back to km on save.
 *
 * Putting these tiny helpers in a shared lib so the Penny onboarding
 * prompts (server) and the React Distance component (client) use exactly
 * the same conversion factor.
 */

export type UnitsPref = 'metric' | 'imperial';

/** Statute miles per kilometer. Plenty of precision for a display label. */
export const MI_PER_KM = 0.621371;

/**
 * km → mi. Returns null if input is null/undefined so callers can chain
 * with optional values.
 */
export function kmToMi(km: number | null | undefined): number | null {
  if (km == null || !Number.isFinite(km)) return null;
  return km * MI_PER_KM;
}

/** mi → km. Same null-safety contract as kmToMi. */
export function miToKm(mi: number | null | undefined): number | null {
  if (mi == null || !Number.isFinite(mi)) return null;
  return mi / MI_PER_KM;
}

/**
 * Format a km value as a string in the active display unit. Always rounds
 * to the nearest whole unit because we're showing planning-grade numbers,
 * not odometer-grade. Use formatKmDual when you want the secondary label.
 */
export function formatKm(km: number | null | undefined, units: UnitsPref): string {
  if (km == null || !Number.isFinite(km)) return '—';
  if (units === 'imperial') {
    const mi = kmToMi(km);
    return mi == null ? '—' : `${Math.round(mi).toLocaleString()} mi`;
  }
  return `${Math.round(km).toLocaleString()} km`;
}

/**
 * The primary/secondary shape `Distance` renders. `primary` is the distance
 * in the user's unit — miles for imperial, kilometres for metric — and
 * `secondary` is always null now.
 *
 * It used to be "km primary, (mi) secondary" for imperial users, on a
 * product decision to teach metric. That decision was reversed 2026-09-04:
 * an imperial user sees miles and no kilometres anywhere. The shape is kept
 * so the call sites did not have to change; the second line is simply never
 * produced, and the whole app moved at once because every distance renders
 * through here or `formatKm`.
 */
export function formatKmDual(
  km: number | null | undefined,
  units: UnitsPref
): { primary: string; secondary: string | null } {
  return { primary: formatKm(km, units), secondary: null };
}

/**
 * A soft planning number: "~652 km" / "~405 mi". The tilde belongs next to
 * the number, so it is applied HERE rather than by callers pasting `~` in
 * front of a string that already carries the unit.
 */
export function approxDistance(km: number | null | undefined, units: UnitsPref): string {
  const s = formatKm(km, units);
  return s === '—' ? s : `~${s}`;
}

/** Narrow a free string to a UnitsPref, defaulting to 'metric'. */
export function asUnitsPref(raw: unknown): UnitsPref {
  return raw === 'imperial' ? 'imperial' : 'metric';
}
