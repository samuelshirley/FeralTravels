/**
 * Dependency-free marker clustering for the trip map.
 *
 * We deliberately do NOT pull in `@googlemaps/markerclusterer`: installing a new
 * npm dependency from the Linux build sandbox would rewrite the macOS-built
 * node_modules and can swap native binaries out from under local dev. This grid
 * clusterer is a small, pure, unit-testable stand-in — easy to swap for the
 * library later if richer behaviour is wanted.
 *
 * The algorithm is the classic screen-space grid: project each point to pixel
 * coordinates at the current zoom (done by the caller, which owns the Google
 * Maps projection), drop it into a fixed-size cell, and group co-celled points.
 * Because it runs on PIXELS (not lat/lng), the same world distance clusters more
 * aggressively when zoomed out and resolves into individual markers when zoomed
 * in — which is exactly the behaviour a user expects.
 */

/** A point already projected to pixel space at the current zoom level. */
export interface PixelPoint {
  /** Stable identifier (e.g. the stop id) — returned verbatim in cluster groups. */
  id: string;
  /** Pixel X at the current zoom. */
  x: number;
  /** Pixel Y at the current zoom. */
  y: number;
}

/** A group of one or more point ids that share a grid cell. */
export interface ClusterGroup {
  /** Ids of the members. Length 1 = a lone marker; >1 = a cluster bubble. */
  ids: string[];
}

/**
 * Group points into screen-space grid cells of `cellSizePx` pixels.
 *
 * - Deterministic: input order is preserved within and across groups, so the
 *   caller can rely on stable marker identity between renders.
 * - A non-positive `cellSize` disables clustering (every point is its own group).
 *
 * @param points       points already projected to pixels at the current zoom
 * @param cellSizePx   grid cell edge in pixels (≈ the min on-screen gap before
 *                     two markers merge). 56–72 reads well on both densities.
 */
export function clusterPixels(
  points: readonly PixelPoint[],
  cellSizePx: number,
): ClusterGroup[] {
  if (cellSizePx <= 0) {
    return points.map((p) => ({ ids: [p.id] }));
  }

  // Preserve first-seen cell order so output is stable across renders.
  const order: string[] = [];
  const cells = new Map<string, string[]>();

  for (const p of points) {
    const cellX = Math.floor(p.x / cellSizePx);
    const cellY = Math.floor(p.y / cellSizePx);
    const key = `${cellX}:${cellY}`;
    const existing = cells.get(key);
    if (existing) {
      existing.push(p.id);
    } else {
      cells.set(key, [p.id]);
      order.push(key);
    }
  }

  return order.map((key) => ({ ids: cells.get(key)! }));
}
