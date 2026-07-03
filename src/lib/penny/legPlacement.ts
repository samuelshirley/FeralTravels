/**
 * Positional inference for add_leg — pure, no DB.
 *
 * WHY (incident 2026-06-29): Penny added a 5-leg "Trondheim → Tromsø in 4
 * days" batch but only passed `after_leg_id` on the FIRST leg. The repo's
 * fallback appended the rest at max(sort_order)+1 — i.e. after Girona, the
 * final leg of a 47-leg trip. Continuity repair then dutifully rewrote the
 * first stranded leg's start to Girona and re-routed it: a 3,383 km /
 * 38-hour "driving day", plus "Leg 2" rendering below "Leg 7".
 *
 * THE RULE: when a new leg arrives with no explicit placement, find where its
 * START coordinates already exist as an END point in the trip; insert right
 * after the last such leg. Chained batches self-place (each new leg starts
 * where the previous one ended), rest days stack after the drive that arrives
 * at their location, and a genuinely new endpoint (no match) appends exactly
 * as before. An explicit `after_leg_id`/`sort_order` always wins — this only
 * runs when Penny gave no placement at all.
 */
import { haversineKm } from './geo';

/** A new leg "continues from" an existing endpoint within this radius. */
export const LEG_CHAIN_MATCH_KM = 50;

export type PlacementLeg = {
  sortOrder: number;
  endLat: number | null;
  endLng: number | null;
};

/**
 * Returns the sort_order of the leg the new leg should be inserted AFTER, or
 * null to append at the end (no start coords, no match, or the match is
 * already the trip's last leg — in which case appending is the same thing).
 */
export function inferInsertAfterSort(
  existing: ReadonlyArray<PlacementLeg>,
  startLat: number | null | undefined,
  startLng: number | null | undefined,
): number | null {
  if (startLat == null || startLng == null || existing.length === 0) return null;

  const maxSort = existing.reduce((mx, l) => Math.max(mx, l.sortOrder), -1);

  // The LAST leg whose end matches the new leg's start: rest days at a
  // location end there too, so a new day inserts after the whole stay, not
  // between the arriving drive and its rest days.
  let best: number | null = null;
  for (const leg of existing) {
    if (leg.endLat == null || leg.endLng == null) continue;
    if (haversineKm(startLat, startLng, leg.endLat, leg.endLng) > LEG_CHAIN_MATCH_KM) continue;
    if (best == null || leg.sortOrder > best) best = leg.sortOrder;
  }

  // Matching the current last leg = plain append; return null so the caller
  // takes the cheap max+1 path without a shift.
  if (best == null || best >= maxSort) return null;
  return best;
}
