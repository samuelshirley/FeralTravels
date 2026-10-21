import { createContext, useContext, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";

/**
 * Native mirror of src/components/DeviceLocationContext.tsx.
 *
 * Owns the app's single location pipeline: one deliberate permission request,
 * then a live watch. Same `gpsStatus` vocabulary as the web so the shared
 * `useNextStop` hook works unchanged on both platforms.
 *
 * IT NEVER ASKS ON MOUNT. Location is asked once, at launch, on the splash
 * (app/index.tsx + shared/lib/launchLocation.ts), and launch does not go on
 * until iOS has an answer — so by the time a trip screen mounts this, the
 * permission is granted or denied and there is nothing to ask. The only prompt
 * from here is `request()`, behind an explicit "turn on location" tap, for the
 * one state launch could not settle (Location Services off device-wide).
 *
 * Build 12 asked here instead, through a primer with a "Not now" that skipped
 * the system dialog — App Review 5.1.1(iv).
 */
export type GpsStatus = "pending" | "active" | "denied" | "unavailable";

/**
 * What a "turn on location" control should actually do, for callers that
 * render one. Two booleans could not express this without a dead-button case:
 *  - `prompt`   — the OS alert is still available; call `request()`.
 *  - `settings` — iOS won't ask again, or Location Services are off
 *                 device-wide. Only the Settings app can fix it.
 *  - `none`     — don't offer the control at all. Read-only template trips
 *                 never prompt (matching the web), so an affordance there
 *                 would spend the one-shot OS alert on a trip that isn't the
 *                 user's.
 */
export type EnablePath = "prompt" | "settings" | "none";

export interface DeviceLocation {
  position: { lat: number; lng: number; accuracy: number | null } | null;
  /**
   * A short label for where the device is ("Girona, Spain"), reverse-geocoded
   * ONCE per session from the first fix through expo-location (no Google
   * dependency). The position report sends it to the server, which is what
   * puts the "Are you leaving from Girona?" chip on the onboarding origin
   * step; the composer placeholder reads it too. Null until resolved, and
   * null for good on a miss.
   */
  place: string | null;
  /** True once the place lookup has settled, hit or miss. */
  placeResolved: boolean;
  gpsStatus: GpsStatus;
  /** What a "turn on location" affordance should do here — see EnablePath. */
  enablePath: EnablePath;
  /** Ask for permission on demand (e.g. from a "turn on location" button). */
  request: () => Promise<void>;
}

const Ctx = createContext<DeviceLocation | null>(null);

export function useDeviceLocation(): DeviceLocation {
  return (
    useContext(Ctx) ?? {
      position: null,
      place: null,
      placeResolved: false,
      gpsStatus: "unavailable",
      enablePath: "none",
      request: async () => {},
    }
  );
}

export function DeviceLocationProvider({
  promptAllowed = true,
  children,
}: {
  promptAllowed?: boolean;
  children: React.ReactNode;
}) {
  const [position, setPosition] = useState<DeviceLocation["position"]>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("pending");
  const [place, setPlace] = useState<string | null>(null);
  const [placeResolved, setPlaceResolved] = useState(false);
  const placeLookupRef = useRef(false);

  // One reverse geocode per session, on the first fix — mirrors
  // src/components/DeviceLocationContext.tsx. The watch keeps updating
  // `position`; the label does not need to follow it.
  useEffect(() => {
    if (!position || placeLookupRef.current) return;
    placeLookupRef.current = true;
    let cancelled = false;
    void (async () => {
      let label: string | null = null;
      try {
        const [hit] = await Location.reverseGeocodeAsync({
          latitude: position.lat,
          longitude: position.lng,
        });
        const town = hit?.city || hit?.subregion || hit?.region || null;
        const country = hit?.country || null;
        label = town ? (country ? `${town}, ${country}` : town) : null;
      } catch {
        label = null;
      }
      if (cancelled) return;
      setPlace(label ? label.slice(0, 200) : null);
      setPlaceResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [position]);
  const [enablePath, setEnablePath] = useState<EnablePath>("none");
  const subRef = useRef<Location.LocationSubscription | null>(null);

  async function start() {
    // Low-accuracy single fix first so the UI has *something* fast, then a
    // high-accuracy watch — same two-stage shape as the web provider.
    try {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
      if (last) {
        setPosition({
          lat: last.coords.latitude,
          lng: last.coords.longitude,
          accuracy: last.coords.accuracy ?? null,
        });
        setGpsStatus("active");
      }
    } catch {
      // No cached fix — the watch below is the real source anyway.
    }
    try {
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 50, timeInterval: 15_000 },
        (loc) => {
          setPosition({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? null,
          });
          setGpsStatus("active");
        }
      );
    } catch {
      setGpsStatus("unavailable");
    }
  }

  /**
   * Raise the system dialog — only ever from an explicit "turn on location"
   * tap, which IS the request.
   */
  async function request() {
    const services = await Location.hasServicesEnabledAsync().catch(() => false);
    if (!services) {
      // Location Services off device-wide. Not something the app prompt can
      // fix, so point the caller at Settings rather than at a dead retry.
      setEnablePath("settings");
      setGpsStatus("unavailable");
      return;
    }
    const res = await Location.requestForegroundPermissionsAsync();
    if (res.status !== "granted") {
      setEnablePath(res.canAskAgain ? "prompt" : "settings");
      setGpsStatus("denied");
      return;
    }
    setEnablePath("none");
    await start();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!promptAllowed) {
        setGpsStatus("denied");
        return;
      }
      const existing = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (cancelled) return;
      if (existing?.status === "granted") {
        await start();
        return;
      }
      // Not granted. Launch has already put the question to iOS, so this is
      // a "Don't Allow" (only Settings can undo it) — or, rarely, still
      // unasked because Location Services were off at launch, where a tap can
      // raise the dialog. Either way: nothing is asked on mount.
      setEnablePath(existing && !existing.canAskAgain ? "settings" : "prompt");
      setGpsStatus("denied");
    })();
    return () => {
      cancelled = true;
      subRef.current?.remove();
      subRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptAllowed]);

  return (
    <Ctx.Provider value={{ position, place, placeResolved, gpsStatus, enablePath, request }}>
      {children}
    </Ctx.Provider>
  );
}
