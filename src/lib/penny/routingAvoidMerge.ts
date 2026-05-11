/**
 * Pure merge of Google Directions `avoid` flags for Penny's get_route lookup.
 * Trip-level user preference (motorway avoidance) unions with whatever the
 * model explicitly passed — no I/O, suitable for unit tests.
 */
export type DirectionsAvoidFlag = 'tolls' | 'highways' | 'ferries';

const STABLE_ORDER: readonly DirectionsAvoidFlag[] = ['highways', 'tolls', 'ferries'];

/**
 * Canonical Google Directions avoid tuple (ordering matches cache keys and URL pipe).
 */
export function canonicalDirectionsAvoid(flags: DirectionsAvoidFlag[]): DirectionsAvoidFlag[] {
  const set = new Set(flags);
  return STABLE_ORDER.filter((f) => set.has(f));
}

export function mergedDirectionsAvoidFromPenny(options: {
  tripPreferAvoidHighways: boolean;
  modelAvoid: DirectionsAvoidFlag[] | null | undefined;
}): DirectionsAvoidFlag[] | undefined {
  const fromTrip: DirectionsAvoidFlag[] = options.tripPreferAvoidHighways ? ['highways'] : [];
  const fromModel = options.modelAvoid ?? [];
  const merged = canonicalDirectionsAvoid([...fromTrip, ...fromModel]);
  if (merged.length === 0) return undefined;
  return merged;
}
