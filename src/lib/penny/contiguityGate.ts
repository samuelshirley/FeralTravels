/**
 * Pre-dispatch contiguity gate — pure simulation, no DB.
 *
 * Before committing a turn's actions, simulate the final leg state and block
 * any delete_leg that would leave a NEW gap (>50 km) between consecutive legs.
 * Penny sometimes deletes a leg without updating the neighbor to close the gap.
 *
 * THE BASELINE MATTERS (bug fixed 2026-07-02): the gate must compare against
 * the gaps the trip ALREADY has, not against "zero gaps". The old version
 * asked "does the post-delete trip have any gap?" — so a trip with one
 * pre-existing gap anywhere could never delete ANY leg again: the culprit
 * isolation loop found no single delete whose reversal removed the (pre-
 * existing) gap, and the conservative fallback then blocked the whole batch.
 * Real incident: "delete all stops after Tromsø" → all 36 deletes blocked by
 * an unrelated 217 km gap near the start of the trip, while Penny's prose
 * claimed success. Deleting a suffix/prefix of a route can never create a
 * gap; only mid-route deletes can — and only those are blocked now.
 */
import type { ValidatedAction } from './tools';
import { haversineKm } from './geo';

/** Anything >50km between consecutive legs is a suspect gap. */
export const LEG_GAP_THRESHOLD_KM = 50;

export type GateLeg = {
  id: string;
  sortOrder: number | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
};

/**
 * In-memory resolve: mirrors resolvePennyLegIdOnTrip but against a Map
 * instead of the DB. Returns the real leg id or null if unresolvable.
 * With UUIDs there's no sort_order confusion — just a direct Map lookup.
 */
function simResolveId(proposedId: string, legMap: Map<string, GateLeg>): string | null {
  if (legMap.has(proposedId)) return proposedId;
  return null;
}

function sortLegs(legs: Iterable<GateLeg>): GateLeg[] {
  return [...legs].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/**
 * Identity keys for every adjacency whose gap exceeds the threshold. Keyed by
 * the two legs' ids so a pre-existing gap stays "the same gap" across
 * simulations, while a new adjacency formed by a delete gets a new key.
 */
function gapKeys(sortedLegs: GateLeg[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < sortedLegs.length - 1; i++) {
    const curr = sortedLegs[i];
    const next = sortedLegs[i + 1];
    if (
      curr.endLat == null || curr.endLng == null ||
      next.startLat == null || next.startLng == null
    ) continue;
    if (haversineKm(curr.endLat, curr.endLng, next.startLat, next.startLng) > LEG_GAP_THRESHOLD_KM) {
      keys.add(`${curr.id}→${next.id}`);
    }
  }
  return keys;
}

/** Gaps in `finalKeys` that were not already present in `baselineKeys`. */
function newGapCount(finalKeys: Set<string>, baselineKeys: Set<string>): number {
  let n = 0;
  for (const k of finalKeys) if (!baselineKeys.has(k)) n += 1;
  return n;
}

/**
 * Apply the turn's actions to an in-memory copy of the legs. Order-sensitive,
 * mirroring dispatch order. `skipDeleteOfId` re-runs the simulation with one
 * delete undone (culprit isolation).
 */
function simulate(
  currentLegs: ReadonlyArray<GateLeg>,
  actions: ReadonlyArray<ValidatedAction>,
  skipDeleteOfId?: string | null,
): GateLeg[] {
  const legMap = new Map<string, GateLeg>();
  for (const leg of currentLegs) legMap.set(leg.id, { ...leg });

  let maxSort = currentLegs.reduce((mx, l) => Math.max(mx, l.sortOrder ?? 0), 0);
  let syntheticIdCounter = 0;

  for (const action of actions) {
    switch (action.name) {
      case 'update_leg': {
        const resolved = simResolveId(action.input.leg_id, legMap);
        if (resolved != null) {
          const leg = legMap.get(resolved)!;
          const d = action.input.data;
          if (d.start_lat !== undefined) leg.startLat = d.start_lat ?? null;
          if (d.start_lng !== undefined) leg.startLng = d.start_lng ?? null;
          if (d.end_lat !== undefined) leg.endLat = d.end_lat ?? null;
          if (d.end_lng !== undefined) leg.endLng = d.end_lng ?? null;
        }
        break;
      }
      case 'add_leg': {
        const synId = `__synthetic_${syntheticIdCounter++}`;
        legMap.set(synId, {
          id: synId,
          sortOrder: action.input.sort_order ?? ++maxSort,
          startLat: action.input.start_lat ?? null,
          startLng: action.input.start_lng ?? null,
          endLat: action.input.end_lat ?? null,
          endLng: action.input.end_lng ?? null,
        });
        break;
      }
      case 'delete_leg': {
        const resolved = simResolveId(action.input.leg_id, legMap);
        if (resolved != null && resolved !== skipDeleteOfId) legMap.delete(resolved);
        break;
      }
      // Other action types don't affect leg geometry
      default:
        break;
    }
  }
  return sortLegs(legMap.values());
}

/**
 * Returns the set of Penny-proposed delete_leg leg_ids that would create a
 * NEW contiguity gap and must be blocked from dispatch. Pure — the caller
 * loads `currentLegs` from the DB.
 */
export function findGapCreatingDeletes(
  currentLegs: ReadonlyArray<GateLeg>,
  actions: ReadonlyArray<ValidatedAction>,
): Set<string> {
  const deleteActions = actions.filter(
    (a): a is ValidatedAction & { name: 'delete_leg' } => a.name === 'delete_leg',
  );

  // No deletes or fewer than 2 legs → nothing to check
  if (deleteActions.length === 0 || currentLegs.length < 2) return new Set();

  // Baseline: the gaps the trip already has. Only gaps ABSENT from this set
  // count against the turn's deletes.
  const baseline = gapKeys(sortLegs(currentLegs.map((l) => ({ ...l }))));

  const finalKeys = gapKeys(simulate(currentLegs, actions));
  if (newGapCount(finalKeys, baseline) === 0) return new Set();

  // New gaps detected — identify culprit deletes by re-simulating without
  // each one. If un-deleting a leg removes all NEW gaps, that delete is the
  // culprit.
  const blockedIds = new Set<string>();
  for (const del of deleteActions) {
    const delResolved = simResolveId(
      del.input.leg_id,
      new Map<string, GateLeg>(currentLegs.map((l) => [l.id, { ...l }])),
    );
    if (delResolved == null) continue;
    const testKeys = gapKeys(simulate(currentLegs, actions, delResolved));
    if (newGapCount(testKeys, baseline) === 0) {
      blockedIds.add(del.input.leg_id);
    }
  }

  // New gaps exist but no single delete is the isolated cause (e.g., two
  // deletes each partially contribute) — block all deletes conservatively.
  // A leg that stays is always safer than a NEW gap in the route.
  if (blockedIds.size === 0) {
    for (const del of deleteActions) blockedIds.add(del.input.leg_id);
  }

  return blockedIds;
}
