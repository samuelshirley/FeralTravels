/**
 * OVERLAND ROUTING SPIKE (not wired to production).
 *
 * Google Directions (+ Penny get_route) plans legal driving roads and can omit
 * motorways via avoid=highways; it cannot prefer gravel surfaces, certify seasonal
 * forest-road access, or stitch multi-track GPX itineraries.
 *
 * A future subsystem would roughly:
 * 1. Ingest permitted motor-vehicle tracks (OSM `tracktype`/`surface` + motor_vehicle,
 *    seasonal closures) into a constrained graph or R-tree-indexed corridors.
 * 2. Optionally align to user/community GPX or WikiLoc-style traces (license hygiene).
 * 3. Emit waypoints compatible with existing trip tools: Penny-side `add_stop`
 *    (selected, distance_from_start_km) plus leg notes / GPX attach.
 * 4. Never claim legality globally — UI copy directs drivers to verify locally.
 *
 * This module exists as a breadcrumb — no routing calls here yet.
 */

export interface TrailWaypointDraft {
  /** Decimal degrees */
  lat: number;
  lng: number;
  /** Free label for map + chat */
  name: string;
  /** Optional metre precision — undefined until a graph exists */
  alongRouteMetres?: number;
}

/** Placeholder: would convert a hypothetical corridor solver output into Penny-friendly stops. */
export function trailWaypointsPlaceholder(_waypoints: TrailWaypointDraft[]): null {
  return null;
}
