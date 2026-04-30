/**
 * Uniform-speed approximation along a decoded route polyline: elapsed drive time
 * is proportional to cumulative distance vs total polyline length. Same proxy as
 * split-route.ts — good enough for where to propose stretch breaks vs fuel.
 */

import {
  haversineKm,
  polylineLengthKm,
  type LatLng,
  type SampledPoint,
} from './polyline';

export type { SampledPoint };

/** Drive minutes accumulated at cumulativeKm along the polyline. */
export function minutesAtKm(
  cumulativeKm: number,
  totalKm: number,
  totalDriveMinutes: number
): number {
  if (totalKm <= 0 || totalDriveMinutes <= 0 || cumulativeKm <= 0) return 0;
  return (Math.min(cumulativeKm, totalKm) / totalKm) * totalDriveMinutes;
}

/**
 * Interpolate `SampledPoint`s at fixed cumulative kilometer markers along `polyline`
 * (same segment math as `samplePolylineEveryKm`).
 */
export function interpolatePointsAtCumulativeKms(
  polyline: LatLng[],
  thresholdKms: number[]
): SampledPoint[] {
  const totalKmAtEnd = polylineLengthKm(polyline);
  const sorted = [...new Set(thresholdKms)]
    .filter((k) => k > 1e-6 && k < totalKmAtEnd - 1e-6)
    .sort((a, b) => a - b);
  if (polyline.length < 2 || sorted.length === 0) return [];

  const out: SampledPoint[] = [];
  let cumulative = 0;
  let ti = 0;

  for (let i = 1; i < polyline.length && ti < sorted.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segment = haversineKm(a, b);
    if (segment === 0) continue;

    while (ti < sorted.length && sorted[ti] <= cumulative + segment + 1e-9) {
      const nextKm = sorted[ti];
      const excess = nextKm - cumulative;
      const tSeg = excess / segment;
      out.push({
        point: {
          lat: a.lat + (b.lat - a.lat) * tSeg,
          lng: a.lng + (b.lng - a.lng) * tSeg,
        },
        distance_km: nextKm,
      });
      ti++;
    }

    cumulative += segment;
  }

  return out;
}

/**
 * Propose knots where estimated driving time reaches `targetSegmentMinutes`,
 * `2 × targetSegmentMinutes`, … before the leg end. Omits the final km band so
 * the last segment runs to the destination (overnight / leg end).
 */
export function samplePolylineByTargetMinutes(
  polyline: LatLng[],
  totalDriveMinutes: number,
  targetSegmentMinutes: number,
  options?: { maxSamples?: number; minDistanceFromEndKm?: number }
): SampledPoint[] {
  const totalKm = polylineLengthKm(polyline);
  if (
    polyline.length < 2 ||
    totalKm <= 0 ||
    totalDriveMinutes <= 0 ||
    targetSegmentMinutes <= 0
  ) {
    return [];
  }

  if (totalDriveMinutes <= targetSegmentMinutes) {
    return [];
  }

  const maxSamples = options?.maxSamples ?? 8;
  const minFromEnd = options?.minDistanceFromEndKm ?? 8;
  const thresholds: number[] = [];
  let n = 1;
  const maxN = Math.floor(totalDriveMinutes / targetSegmentMinutes);

  while (thresholds.length < maxSamples && n <= maxN) {
    const kmAtN = ((n * targetSegmentMinutes) / totalDriveMinutes) * totalKm;
    if (kmAtN >= totalKm - minFromEnd) break;
    thresholds.push(kmAtN);
    n++;
  }

  return interpolatePointsAtCumulativeKms(polyline, thresholds);
}

export type MergedRouteKnot = {
  point: LatLng;
  distance_km: number;
  needFuel: boolean;
  needStretch: boolean;
};

/**
 * Union fuel-range samples and time-based stretch samples; merge pairs within
 * `mergeGapKm` along-route. When both fuel and stretch apply at a cluster,
 * callers usually keep fuel-only Places lookup (walk the dog at the station).
 */
export function mergeFuelAndStretchSamples(
  fuelSamples: SampledPoint[],
  stretchSamples: SampledPoint[],
  mergeGapKm: number
): MergedRouteKnot[] {
  type Tagged = { km: number; point: LatLng; fuel: boolean; stretch: boolean };
  const tagged: Tagged[] = [
    ...fuelSamples.map((s) => ({
      km: s.distance_km,
      point: s.point,
      fuel: true,
      stretch: false,
    })),
    ...stretchSamples.map((s) => ({
      km: s.distance_km,
      point: s.point,
      fuel: false,
      stretch: true,
    })),
  ].sort((a, b) => a.km - b.km);

  const out: MergedRouteKnot[] = [];
  for (const t of tagged) {
    const last = out[out.length - 1];
    if (last && t.km - last.distance_km <= mergeGapKm) {
      last.needFuel = last.needFuel || t.fuel;
      last.needStretch = last.needStretch || t.stretch;
      last.distance_km = t.km;
      last.point = t.point;
    } else {
      out.push({
        distance_km: t.km,
        point: t.point,
        needFuel: t.fuel,
        needStretch: t.stretch,
      });
    }
  }
  return out;
}
