'use client';

/**
 * DeviceLocationContext — the ONE client-side source of truth for the
 * device's GPS position.
 *
 * Before this existed there were two independent geolocation consumers that
 * never talked to each other (the client-side twin of the "wire device GPS to
 * Penny" bug, commit ee151da):
 *
 *   1. TripWorkspace fired the on-load position prompt, got coords, POSTed
 *      them to the server for Penny — then threw them away in the browser.
 *   2. useNextStop (smart nav, per leg card) queried the permission state
 *      once at card-expand. If the state was 'prompt' at that instant (the
 *      popup literally on screen, not yet answered), it permanently resolved
 *      to 'unavailable' for that mount — so granting the prompt a moment
 *      later did nothing and the card stayed on the full button list. This
 *      is why desktop showed the location popup AND the un-collapsed
 *      3-button list at the same time.
 *
 * The provider owns the single deliberate prompt (fired on workspace load
 * when the permission state is 'prompt' and prompting is allowed), keeps a
 * live watchPosition running while permission is granted, and — crucially —
 * subscribes to the Permissions API `onchange` so a grant that lands AFTER
 * mount flips every consumer live. Consumers (position report, smart nav)
 * just read context; none of them call the Geolocation API directly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LatLng } from '@/lib/polyline';
import { reverseGeocode } from '@/lib/reverseGeocode';

export type GpsStatus = 'pending' | 'active' | 'denied' | 'unavailable';

/**
 * What a "turn location on" control can actually DO from here, which differs
 * from native in a way worth stating.
 *
 *   'prompt'   — never asked, or asked and dismissed. Calling `request()`
 *                raises the browser's own permission dialog.
 *   'settings' — DENIED. There is no web API that reopens a permission pane,
 *                so the only honest control is a sentence telling the user
 *                where to change it. `request()` deliberately does nothing:
 *                calling getCurrentPosition against a denied permission fails
 *                silently and teaches the user the button is broken.
 *   'none'     — no Geolocation API at all, or nothing to offer.
 *
 * Mirrors the shape of `enablePath` in mobile/lib/location.tsx, where the
 * 'settings' case CAN act (Linking.openSettings). Same name, same three
 * states, different capability — which is exactly why the caller branches on
 * the path rather than on `gpsStatus`.
 */
export type EnablePath = 'none' | 'prompt' | 'settings';

export interface DeviceLocation {
  /** Latest known device position, or null before the first fix / when unavailable. */
  position: LatLng | null;
  /**
   * A short label for where the device is ("Girona, Spain"), reverse-geocoded
   * ONCE per session from the first fix — the same lookup the position report
   * sends the server, so the onboarding chip, the composer placeholder and
   * Penny's `device_location` all name the same place. Null until resolved,
   * and null for good when the lookup misses (no key, no result).
   */
  place: string | null;
  /** True once the place lookup has settled, hit or miss. */
  placeResolved: boolean;
  /** Current GPS acquisition state. */
  gpsStatus: GpsStatus;
  /** What a "turn it on" control can do from here. See EnablePath. */
  enablePath: EnablePath;
  /** Raise the browser permission dialog. No-op unless enablePath is 'prompt'. */
  request: () => void;
}

const DEFAULT_VALUE: DeviceLocation = {
  position: null,
  place: null,
  placeResolved: false,
  gpsStatus: 'unavailable',
  enablePath: 'none',
  request: () => {},
};

const DeviceLocationContext = createContext<DeviceLocation>(DEFAULT_VALUE);

/** Read the shared device location. Safe without a provider (degrades to unavailable). */
export function useDeviceLocation(): DeviceLocation {
  return useContext(DeviceLocationContext);
}

export function DeviceLocationProvider({
  children,
  /**
   * Whether this mount may fire the browser's location prompt when the
   * permission state is 'prompt'. False for readonly views — but note an
   * ALREADY-granted permission is still read/watched regardless, so a
   * readonly view with granted permission still gets smart nav.
   */
  promptAllowed = true,
}: {
  children: ReactNode;
  promptAllowed?: boolean;
}) {
  const [position, setPosition] = useState<LatLng | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('pending');
  // Guard so a permission onchange → granted can't stack a second watch.
  const startedRef = useRef(false);
  const [place, setPlace] = useState<string | null>(null);
  const [placeResolved, setPlaceResolved] = useState(false);
  const placeLookupRef = useRef(false);

  // One reverse geocode per session, on the first fix. The watch keeps
  // updating `position` (smart nav wants metres); the label does not need to
  // follow it — a driver does not leave town between two onboarding steps.
  useEffect(() => {
    if (!position || placeLookupRef.current) return;
    placeLookupRef.current = true;
    let cancelled = false;
    void (async () => {
      let label: string | null = null;
      try {
        label = await reverseGeocode(position.lat, position.lng);
      } catch {
        label = null;
      }
      if (cancelled) return;
      setPlace(label);
      setPlaceResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [position]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('unavailable');
      return;
    }

    let cancelled = false;
    let watchId: number | null = null;
    let permStatus: PermissionStatus | null = null;

    const startReadingAndWatching = () => {
      if (cancelled || startedRef.current) return;
      startedRef.current = true;
      // Single fast read first so consumers have something immediately.
      // When the permission state is 'prompt', THIS is the one deliberate
      // location prompt for the app.
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGpsStatus('active');
        },
        (err) => {
          if (cancelled) return;
          setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
          // Allow a retry if permission flips to granted later (e.g. the user
          // enables location in browser settings after an initial failure).
          startedRef.current = false;
        },
        { enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 },
      );

      // Then keep it fresh while the workspace is open.
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGpsStatus('active');
        },
        () => {
          // Silent — the initial read (or its error) already set the status.
        },
        { enableHighAccuracy: true, maximumAge: 15_000 },
      );
    };

    const applyPermissionState = (state: PermissionState) => {
      if (cancelled) return;
      if (state === 'granted') {
        startReadingAndWatching();
      } else if (state === 'denied') {
        setGpsStatus('denied');
      } else {
        // 'prompt' — fire the one deliberate prompt only when allowed.
        if (promptAllowed) {
          startReadingAndWatching();
        } else {
          setGpsStatus('unavailable');
        }
      }
    };

    if (!navigator.permissions?.query) {
      // No Permissions API (older webviews) — preserve original behavior.
      if (promptAllowed) startReadingAndWatching();
      else setGpsStatus('unavailable');
    } else {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((status) => {
          if (cancelled) return;
          permStatus = status;
          applyPermissionState(status.state);
          // THE fix for "granted after mount": react to permission changes so
          // an Allow click (or a settings change) activates GPS live instead
          // of requiring a reload.
          status.onchange = () => applyPermissionState(status.state);
        })
        .catch(() => {
          // Query failed — fall back rather than leaving GPS dead.
          if (!cancelled && promptAllowed) startReadingAndWatching();
        });
    }

    return () => {
      cancelled = true;
      startedRef.current = false;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (permStatus) permStatus.onchange = null;
    };
  }, [promptAllowed]);

  /*
   * A denied permission is a ONE-WAY DOOR on the web without this: nothing
   * else in the app can re-raise the dialog, and the provider fires its single
   * deliberate prompt only on mount. `request()` is the way back for the
   * 'prompt' case; 'denied' has no way back that the page can trigger, and
   * says so rather than offering a button that silently fails.
   */
  const enablePath: EnablePath = useMemo(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return 'none';
    if (gpsStatus === 'denied') return 'settings';
    if (gpsStatus === 'active') return 'none';
    return 'prompt';
  }, [gpsStatus]);

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    // Only meaningful from 'prompt'. Against a denied permission this resolves
    // to the same error forever, so the caller is expected not to offer it.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsStatus('active');
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  const value = useMemo(
    () => ({ position, place, placeResolved, gpsStatus, enablePath, request }),
    [position, place, placeResolved, gpsStatus, enablePath, request]
  );

  return (
    <DeviceLocationContext.Provider value={value}>{children}</DeviceLocationContext.Provider>
  );
}
