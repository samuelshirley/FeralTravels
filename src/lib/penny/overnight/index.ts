import 'server-only';

/**
 * Overnight-stop engine — deterministic, OSM-backed.
 *
 * Pipeline: route polyline + daily-reach km → anchor window (anchor.ts) →
 * OSM candidates in that window's bbox (overpass.ts) → ranked shortlist
 * (rank.ts). No LLM in the decision; Penny only triggers it and presents the
 * result, consistent with "Penny is a wrapper only."
 *
 * Not yet wired: a `planOvernightStop` Penny tool, auto-apply via the replan
 * engine (deferred until the replan/leg-ordering bugs are fixed), and the
 * fuel-price corridor + satellite/CV ranking layer. See
 * docs/overnight-stop-feature-scope.md.
 */

import { computeOvernightWindow, type AnchorInput, type OvernightWindow } from './anchor';
import { findCandidatesInBBox, type FetchOverpassOptions, type OsmCandidate } from './overpass';
import {
  rankOvernightCandidates,
  type RankedCandidate,
  type RankWeights,
} from './rank';

export * from './anchor';
export * from './overpass';
export * from './rank';

export interface PlanOvernightStopInput extends AnchorInput {
  weights?: RankWeights;
  lotPairRadiusKm?: number;
  overpass?: FetchOverpassOptions;
}

export interface PlanOvernightStopResult {
  window: OvernightWindow;
  /** Everything OSM returned in the window, before ranking. */
  rawCandidates: OsmCandidate[];
  /** Ranked overnight shortlist, best first (fuel excluded). */
  ranked: RankedCandidate[];
}

/**
 * End-to-end: find ranked overnight candidates near the day's reach along a
 * route. The only step that touches the network is the Overpass query, scoped
 * to the small window bbox.
 */
export async function planOvernightStop(
  input: PlanOvernightStopInput
): Promise<PlanOvernightStopResult> {
  const window = computeOvernightWindow(input);
  const rawCandidates = await findCandidatesInBBox(window.bbox, input.overpass);
  const ranked = rankOvernightCandidates({
    candidates: rawCandidates,
    anchor: window.anchor,
    routePolyline: window.windowPolyline,
    weights: input.weights,
    lotPairRadiusKm: input.lotPairRadiusKm,
  });
  return { window, rawCandidates, ranked };
}
