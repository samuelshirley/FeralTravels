import 'server-only';

/**
 * Move each overnight split to a town a driver would actually stop in, and name
 * it.
 *
 * THE BUG (reported 2026-09-21, Girona → Annecy, 657 km at a 4 h daily cap).
 * `split-route.ts` puts the split at exactly 50% of drive time and
 * `lib/osm/nominatim.ts` names whatever settlement is nearest that coordinate.
 * The 50% mark fell on the A9 outside Tavel — a village of about 1,800 people —
 * so the itinerary read "Girona → Tavel" and "Tavel → Annecy". Nothing was
 * wrong with either half: the coordinate is genuinely the halfway point and
 * Tavel is genuinely its nearest settlement. The plan was still useless,
 * because a village nobody has heard of reads as the plan rather than as the
 * placeholder `split-route.ts`'s own docstring says it is.
 *
 * THE FIX. The split point is not a fact; it is a choice inside a tolerance.
 * The daily cap is the fact. So walk the polyline outward from the planned
 * split and take the first point that reverse-geocodes to a `city` or a `town`,
 * subject to two hard constraints:
 *
 *   1. NEITHER neighbouring day may exceed the daily cap. Moving forward always
 *      shortens the next day and is safe; moving backward lengthens it and is
 *      often not.
 *   2. The move stays inside `tolerance_minutes` of the planned split, so a day
 *      is nudged, never redesigned.
 *
 * On the reported trip, +20 km lands in Orange (a town on the A7, and the
 * junction a driver would pick anyway) at a cost of about 12 minutes on day 1 —
 * well inside the 171 km of slack that plan already had.
 *
 * WHAT IT COSTS. One Nominatim call per probe, serialised at their mandatory
 * 1 req/s, so `max_probes` is a LATENCY budget, not a money one — Nominatim is
 * free. Probes stop at the first city or town, and the planned split is always
 * probed first, so a day that already ends somewhere real costs exactly one
 * call, which it cost before this module existed.
 *
 * Every failure degrades to the planned split and its own label: a name is a
 * nicety and must never be able to fail a plan.
 */

import type { PlaceLookup, SettlementRank } from '@/lib/osm/nominatim';
import { rankAtLeast } from '@/lib/osm/nominatim';
import type { SplitPlan } from './split-route';

/** How far a split may be nudged, and how hard we look. */
export interface SnapOptions {
  /**
   * Maximum detour from the planned split, in minutes of driving. 25 minutes is
   * roughly 30 km at motorway speed — far enough to reach the next real town on
   * a European corridor, short enough that the day still ends where the plan
   * said it would.
   */
  tolerance_minutes?: number;
  /** Distance between probes, in minutes. */
  step_minutes?: number;
  /** Hard ceiling on Nominatim calls per split point, including the first. */
  max_probes?: number;
  /**
   * The smallest settlement worth moving for. `town` means a city or a town
   * will do; it never moves to reach another village.
   */
  min_rank?: SettlementRank;
}

const DEFAULTS: Required<SnapOptions> = {
  tolerance_minutes: 25,
  step_minutes: 12,
  max_probes: 5,
  min_rank: 'town',
};

export interface NamedSplit {
  /** Polyline index this driving day ends at, after any move. */
  index: number;
  /** The name to use VERBATIM as the leg's end_name. Null when unresolved. */
  name: string | null;
  rank: SettlementRank;
  /** Minutes this split moved from where `split-route.ts` planned it. Signed. */
  moved_minutes: number;
  /** Nominatim calls spent on this split. */
  probes: number;
}

/** Injected so the tests never touch the network. */
export type LookupFn = (lat: number, lng: number) => Promise<PlaceLookup>;

/**
 * Name every driving day's end, moving the interior splits to a town where one
 * is within tolerance.
 *
 * The FINAL index is the user's destination and is never moved — they said
 * where they were going. It is still named, because the leg needs an end_name.
 */
export async function nameSplitPoints(
  plan: SplitPlan,
  lookup: LookupFn,
  options: SnapOptions = {}
): Promise<NamedSplit[]> {
  const opts = { ...DEFAULTS, ...options };
  const { polyline_points: pts, cumulative_km: cum, polyline_total_km: totalKm } = plan;
  const cap = plan.max_drive_minutes_per_day;

  if (pts.length < 2 || totalKm <= 0 || plan.total_drive_time_minutes <= 0) {
    return plan.indices.map((index) => ({
      index,
      name: null,
      rank: 'none' as const,
      moved_minutes: 0,
      probes: 0,
    }));
  }

  /** The uniform-speed proxy the rest of the module runs on. */
  const minutesPerKm = plan.total_drive_time_minutes / totalKm;
  const minutesBetween = (a: number, b: number) => (cum[b] - cum[a]) * minutesPerKm;

  // One call per polyline index at most, however many splits ask about it.
  const seen = new Map<number, PlaceLookup>();
  let calls = 0;
  const probe = async (idx: number): Promise<PlaceLookup> => {
    const hit = seen.get(idx);
    if (hit) return hit;
    const [lat, lng] = pts[idx];
    const got = await lookup(lat, lng);
    calls++;
    seen.set(idx, got);
    return got;
  };

  /** First polyline index at or past `km` along the route. */
  const indexAtKm = (km: number): number => {
    if (km <= 0) return 0;
    let i = 0;
    while (i < cum.length - 1 && cum[i] < km) i++;
    return i;
  };

  const out: NamedSplit[] = [];
  let prevIdx = 0;

  for (let d = 0; d < plan.indices.length; d++) {
    const planned = plan.indices[d];
    const isDestination = d === plan.indices.length - 1;
    const nextIdx = isDestination ? null : plan.indices[d + 1];

    const callsBefore = calls;
    const atPlanned = await probe(planned);

    let chosen = planned;
    let lookupAt = atPlanned;

    if (!isDestination && !rankAtLeast(atPlanned.rank, opts.min_rank)) {
      // Probe outward, nearest first, alternating forward then back so a tie
      // goes to the smaller detour rather than to a direction.
      const offsets: number[] = [];
      for (let m = opts.step_minutes; m <= opts.tolerance_minutes; m += opts.step_minutes) {
        offsets.push(m, -m);
      }

      const tried = new Set<number>([planned]);
      for (const offset of offsets) {
        if (calls - callsBefore >= opts.max_probes) break;

        const candidate = indexAtKm(cum[planned] + offset / minutesPerKm);
        // A cached candidate is re-USED, not skipped — `probe` returns it
        // without spending a call, and it may well be the town we are after.
        if (tried.has(candidate)) continue;
        tried.add(candidate);

        // Constraint 1: neither neighbouring day may bust the cap.
        if (minutesBetween(prevIdx, candidate) > cap) continue;
        if (nextIdx != null && minutesBetween(candidate, nextIdx) > cap) continue;
        // A split must stay strictly between its neighbours.
        if (candidate <= prevIdx || (nextIdx != null && candidate >= nextIdx)) continue;

        const got = await probe(candidate);
        if (rankAtLeast(got.rank, opts.min_rank)) {
          chosen = candidate;
          lookupAt = got;
          break;
        }
      }
    }

    out.push({
      index: chosen,
      name: lookupAt.label,
      rank: lookupAt.rank,
      moved_minutes: Math.round(minutesBetween(planned, chosen)),
      probes: calls - callsBefore,
    });
    prevIdx = chosen;
  }

  return out;
}
