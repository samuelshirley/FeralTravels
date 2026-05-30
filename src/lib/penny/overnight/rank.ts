import 'server-only';

import { haversineKm } from '../geo';
import type { LatLng } from './anchor';
import type { OsmCandidate } from './overpass';

/**
 * Deterministic ranking of overnight candidates.
 *
 * The calibration discriminator from real spots: it's NOT "park vs dog park"
 * — both good spots so far ARE dog parks. It's *"is there a real adjacent
 * parking lot."* Good = green space + lot; bad = green space + no lot (the
 * spot Penny wrongly suggested in Innsbruck). So a park/dog_park only scores
 * well if a parking lot sits next to it; standalone lots and caravan sites
 * score on their own.
 *
 * Weights are named constants so they're easy to retune against ground truth
 * (see the calibration table in docs/overnight-stop-feature-scope.md). Pure
 * function — no DB, no network, no LLM.
 */

export interface RankWeights {
  /** Score lost per km of detour from the route. */
  detourKmPenalty: number;
  /** Score lost per km the candidate sits from the day's anchor. */
  anchorOffsetKmPenalty: number;
  /** Bonus for having a real (adjacent) parking lot — the key discriminator. */
  hasLotBonus: number;
  /** Extra bonus for a dedicated caravan/motorhome site. */
  caravanSiteBonus: number;
  /** Bonus when OSM tags signal motorhome/overnight tolerance. */
  motorhomeTagBonus: number;
  /** Small bonus for unpaved/gravel surface (overlander-friendly, low-key). */
  unpavedSurfaceBonus: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  detourKmPenalty: 4,
  anchorOffsetKmPenalty: 0.5,
  hasLotBonus: 10,
  caravanSiteBonus: 12,
  motorhomeTagBonus: 8,
  unpavedSurfaceBonus: 2,
};

/** A park/dog_park "has a lot" if a parking lot is within this radius. */
const DEFAULT_LOT_PAIR_RADIUS_KM = 0.2;

const UNPAVED_SURFACES = new Set([
  'gravel',
  'fine_gravel',
  'unpaved',
  'ground',
  'dirt',
  'earth',
  'compacted',
  'grass',
]);

export interface RankInput {
  candidates: OsmCandidate[];
  /** The day's anchor point (from computeOvernightWindow). */
  anchor: LatLng;
  /** Route geometry to measure detour against (the window polyline is fine). */
  routePolyline: LatLng[];
  weights?: RankWeights;
  lotPairRadiusKm?: number;
}

export interface RankedCandidate {
  candidate: OsmCandidate;
  score: number;
  detourKm: number;
  anchorOffsetKm: number;
  hasAdjacentLot: boolean;
  breakdown: Record<string, number>;
}

/** Minimum haversine distance from a point to any vertex of the polyline. */
function minDistanceToPolylineKm(lat: number, lng: number, polyline: LatLng[]): number {
  let min = Infinity;
  for (const [plat, plng] of polyline) {
    const d = haversineKm(lat, lng, plat, plng);
    if (d < min) min = d;
  }
  return min;
}

function isLot(c: OsmCandidate): boolean {
  return c.category === 'parking' || c.category === 'caravan_site';
}

/**
 * Rank overnight candidates best-first. `fuel` candidates are excluded — they
 * belong to the fuel layer, not the overnight shortlist.
 */
export function rankOvernightCandidates(input: RankInput): RankedCandidate[] {
  const weights = input.weights ?? DEFAULT_RANK_WEIGHTS;
  const lotPairRadiusKm = input.lotPairRadiusKm ?? DEFAULT_LOT_PAIR_RADIUS_KM;
  const [anchorLat, anchorLng] = input.anchor;

  const considered = input.candidates.filter((c) => c.category !== 'fuel');
  const lots = considered.filter(isLot);

  const ranked = considered.map((candidate): RankedCandidate => {
    const detourKm = minDistanceToPolylineKm(
      candidate.lat,
      candidate.lng,
      input.routePolyline
    );
    const anchorOffsetKm = haversineKm(
      candidate.lat,
      candidate.lng,
      anchorLat,
      anchorLng
    );

    // Does this candidate have a usable lot?
    let hasAdjacentLot: boolean;
    if (isLot(candidate)) {
      hasAdjacentLot = true;
    } else {
      hasAdjacentLot = lots.some(
        (lot) =>
          lot.osmId !== candidate.osmId &&
          haversineKm(candidate.lat, candidate.lng, lot.lat, lot.lng) <= lotPairRadiusKm
      );
    }

    const breakdown: Record<string, number> = {
      hasLot: hasAdjacentLot ? weights.hasLotBonus : 0,
      caravanSite: candidate.category === 'caravan_site' ? weights.caravanSiteBonus : 0,
      motorhomeTag: candidate.motorhomeFriendly ? weights.motorhomeTagBonus : 0,
      unpavedSurface:
        candidate.surface !== null && UNPAVED_SURFACES.has(candidate.surface)
          ? weights.unpavedSurfaceBonus
          : 0,
      detour: -weights.detourKmPenalty * detourKm,
      anchorOffset: -weights.anchorOffsetKmPenalty * anchorOffsetKm,
    };

    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return { candidate, score, detourKm, anchorOffsetKm, hasAdjacentLot, breakdown };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
