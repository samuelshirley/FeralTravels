
import { useMemo } from 'react';
import { haversineKm, type LatLng } from '../lib/polyline';
import type { NavSegment } from '../lib/maps';
import { useDeviceLocation, type GpsStatus } from '@/lib/location';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { GpsStatus };

export interface NextStopResult {
  /** The single recommended "navigate to" segment, or null while loading / if no segments. */
  nextStop: NavSegment | null;
  /** All segments in route order — used as fallback when GPS is unavailable or user is far away. */
  allSegments: NavSegment[];
  /** True when user's GPS position is within range of the route. */
  isNearRoute: boolean;
  /** Current GPS acquisition state. */
  gpsStatus: GpsStatus;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** If the user is more than this many km from every destination point *and*
 *  the leg start, we consider them "far from route" (probably planning). */
const FAR_FROM_ROUTE_KM = 50;

/** A stop is considered "reached" when the user is within this radius. */
const ARRIVAL_RADIUS_KM = 2;

// ---------------------------------------------------------------------------
// Pure selection logic (unit-tested in useNextStop.test.ts)
// ---------------------------------------------------------------------------

/** Extract destination coords from segment URLs (they carry `destination=lat,lng`). */
export function segmentDestinations(segments: NavSegment[]): LatLng[] {
  return segments
    .map((seg) => {
      try {
        const u = new URL(seg.url);
        const dest = u.searchParams.get('destination');
        if (dest) {
          const [lat, lng] = dest.split(',').map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat, lng };
          }
        }
      } catch {
        /* ignore */
      }
      return null;
    })
    .filter((p): p is LatLng => p !== null);
}

/**
 * Pick the smart-nav "next stop" for a user position.
 *
 * - Far from every route point (> FAR_FROM_ROUTE_KM) → not near route,
 *   caller shows the full list.
 * - Near the route → the first destination (in route order) the user hasn't
 *   reached yet (> ARRIVAL_RADIUS_KM away).
 * - Within arrival radius of everything → the final destination.
 */
export function pickNextStop(
  segments: NavSegment[],
  destPoints: LatLng[],
  userPos: LatLng,
  legStart: LatLng | null,
): { nextStop: NavSegment | null; isNearRoute: boolean } {
  if (segments.length === 0) return { nextStop: null, isNearRoute: false };

  const allPoints: LatLng[] = legStart ? [legStart, ...destPoints] : destPoints;
  if (allPoints.length === 0) return { nextStop: null, isNearRoute: false };

  const nearestPointDist = Math.min(...allPoints.map((p) => haversineKm(userPos, p)));
  if (nearestPointDist > FAR_FROM_ROUTE_KM) {
    return { nextStop: null, isNearRoute: false };
  }

  for (let i = 0; i < destPoints.length; i++) {
    if (haversineKm(userPos, destPoints[i]) > ARRIVAL_RADIUS_KM) {
      return { nextStop: segments[i], isNearRoute: true };
    }
  }

  // Within arrival radius of every stop — show the final destination.
  return { nextStop: segments[segments.length - 1], isNearRoute: true };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Determine the next navigation stop for a leg based on the device position
 * from DeviceLocationContext (the app's single GPS pipeline — this hook no
 * longer touches the Geolocation API itself). Falls back gracefully:
 *
 *  - GPS active + near route → single `nextStop` (first stop in route
 *    order the user hasn't reached yet)
 *  - GPS active but far from route → `isNearRoute = false`, caller
 *    should show `allSegments` as a list
 *  - GPS denied / unavailable / still pending → `gpsStatus` tells caller
 *    to show the list
 *
 * History: this hook used to run its own permissions.query + watchPosition
 * per card-expand. If the permission state was 'prompt' at that moment (the
 * on-load popup visible but unanswered) it locked itself to 'unavailable'
 * for the whole mount — granting the prompt did nothing until a reload. The
 * shared provider subscribes to permission changes, so that race is gone.
 */
export function useNextStop(
  segments: NavSegment[] | null,
  legStart: LatLng | null,
  /** Compute only when the card is expanded (result is unused while collapsed). */
  enabled = true,
): NextStopResult {
  const { position: userPos, gpsStatus } = useDeviceLocation();

  const allSegments = useMemo(() => segments ?? [], [segments]);

  const destPoints: LatLng[] = useMemo(
    () => segmentDestinations(allSegments),
    [allSegments],
  );

  return useMemo(() => {
    if (!enabled || allSegments.length === 0 || !userPos || gpsStatus !== 'active') {
      return { nextStop: null, allSegments, isNearRoute: false, gpsStatus };
    }
    const { nextStop, isNearRoute } = pickNextStop(allSegments, destPoints, userPos, legStart);
    return { nextStop, allSegments, isNearRoute, gpsStatus };
  }, [enabled, userPos, gpsStatus, allSegments, destPoints, legStart]);
}
