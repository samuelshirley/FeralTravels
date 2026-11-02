/**
 * Lat/lng → SVG coordinates for the intro's small maps. Equirectangular with
 * the longitude squeezed by cos(mid-latitude) — at Spain's latitudes that is
 * within a percent or two of what a Mercator map shows, and it needs no
 * library. The whole set is fitted into the box with `pad` on every side and
 * its aspect ratio kept.
 */
export type LatLngPair = readonly [number, number];

export interface Projector {
  (p: LatLngPair): { x: number; y: number };
}

export function fitProjector(points: readonly LatLngPair[], width: number, height: number, pad: number): Projector {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of points) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * k, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  return ([lat, lng]) => ({
    x: offX + (lng - minLng) * k * scale,
    y: offY + (maxLat - lat) * scale,
  });
}

export function pathFor(points: readonly LatLngPair[], project: Projector): string {
  return points
    .map((p, i) => {
      const { x, y } = project(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
