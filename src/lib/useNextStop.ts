'use client';

import { useEffect, useMemo, useState } from 'react';
import { haversineKm, type LatLng } from '@/lib/polyline';
import type { NavSegment } from '@/lib/maps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GpsStatus = 'pending' | 'active' | 'denied' | 'unavailable';

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
// Hook
// ---------------------------------------------------------------------------

/**
 * Determine the next navigation stop for a leg based on the user's GPS
 * position. Falls back gracefully:
 *
 *  - GPS available + near route → single `nextStop` (first stop in route
 *    order the user hasn't reached yet)
 *  - GPS available but far from route → `isNearRoute = false`, caller
 *    should show `allSegments` as a list
 *  - GPS denied / unavailable → `gpsStatus` tells caller to show list
 *
 * GPS is only requested when the hook mounts (i.e., when the leg card
 * expands) and watched while mounted. No server calls.
 */
export function useNextStop(
  segments: NavSegment[] | null,
  legStart: LatLng | null,
  /** Only request GPS when true (e.g., card is expanded). */
  enabled = true,
): NextStopResult {
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('pending');

  // Request GPS when enabled, watch while enabled.
  //
  // Prompt policy: this hook runs every time a leg card expands, so if it called
  // getCurrentPosition unconditionally it would surface the browser's location
  // prompt at a seemingly random moment (the "why is it asking now?" bug). The
  // ONE deliberate prompt lives in TripWorkspace's on-load position report. Here
  // we only read/watch when permission is ALREADY granted; if it's still in the
  // "prompt" state we stay passive and fall back to the segment list rather than
  // firing a second, mistimed prompt. When the Permissions API is unavailable
  // (older webviews) we preserve the original prompt-on-expand behavior so the
  // nav feature still works.
  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setGpsStatus('unavailable');
      return;
    }

    let cancelled = false;
    let watchId: number | null = null;

    const startReadingAndWatching = () => {
      if (cancelled) return;
      // Single fast read first so we have something immediately.
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGpsStatus('active');
        },
        (err) => {
          if (cancelled) return;
          setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
        },
        { enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 },
      );

      // Then watch for updates while the card is open.
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGpsStatus('active');
        },
        () => {
          // Silent — we already have the initial read or its error.
        },
        { enableHighAccuracy: true, maximumAge: 15_000 },
      );
    };

    if (!navigator.permissions?.query) {
      // No Permissions API — preserve the original behavior (may prompt).
      startReadingAndWatching();
    } else {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((status) => {
          if (cancelled) return;
          if (status.state === 'granted') {
            startReadingAndWatching();
          } else if (status.state === 'denied') {
            setGpsStatus('denied');
          } else {
            // 'prompt' — don't fire a mistimed prompt here; show the list. The
            // on-load request owns the single prompt.
            setGpsStatus('unavailable');
          }
        })
        .catch(() => {
          // Query failed — fall back to the original behavior rather than
          // leaving the card stuck without nav.
          if (!cancelled) startReadingAndWatching();
        });
    }

    return () => {
      cancelled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled]);

  const allSegments = segments ?? [];

  // Build the ordered destination points (for distance checks).
  // Each NavSegment's URL contains the destination coords — but we also
  // receive them implicitly via the segment list order matching the stop
  // order. To avoid parsing URLs we pass the coords alongside.
  //
  // We extract destination coords from the segment URLs:
  const destPoints: LatLng[] = useMemo(() => {
    return allSegments.map((seg) => {
      try {
        const u = new URL(seg.url);
        const dest = u.searchParams.get('destination');
        if (dest) {
          const [lat, lng] = dest.split(',').map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat, lng };
          }
        }
      } catch { /* ignore */ }
      return null;
    }).filter((p): p is LatLng => p !== null);
  }, [allSegments]);

  return useMemo(() => {
    // No segments at all — nothing to show.
    if (allSegments.length === 0) {
      return { nextStop: null, allSegments, isNearRoute: false, gpsStatus };
    }

    // No GPS yet — caller decides how to render.
    if (!userPos || gpsStatus !== 'active') {
      return { nextStop: null, allSegments, isNearRoute: false, gpsStatus };
    }

    // Check if user is near the route at all.
    const allPoints: LatLng[] = legStart ? [legStart, ...destPoints] : destPoints;
    const nearestPointDist = Math.min(
      ...allPoints.map((p) => haversineKm(userPos, p)),
    );
    const isNearRoute = nearestPointDist <= FAR_FROM_ROUTE_KM;

    if (!isNearRoute) {
      return { nextStop: null, allSegments, isNearRoute: false, gpsStatus };
    }

    // Walk stops in route order. The "next stop" is the first destination
    // the user is more than ARRIVAL_RADIUS_KM from.
    for (let i = 0; i < destPoints.length; i++) {
      const dist = haversineKm(userPos, destPoints[i]);
      if (dist > ARRIVAL_RADIUS_KM) {
        return { nextStop: allSegments[i], allSegments, isNearRoute: true, gpsStatus };
      }
    }

    // User is within arrival radius of every stop — show the last one
    // (the final destination). They might be wrapping up.
    return {
      nextStop: allSegments[allSegments.length - 1],
      allSegments,
      isNearRoute: true,
      gpsStatus,
    };
  }, [userPos, gpsStatus, allSegments, destPoints, legStart]);
}
