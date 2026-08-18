import { createContext, useContext, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";

/**
 * Native mirror of src/components/DeviceLocationContext.tsx.
 *
 * Owns the app's single location pipeline: one deliberate permission request,
 * then a live watch. Same `gpsStatus` vocabulary as the web so the shared
 * `useNextStop` hook works unchanged on both platforms.
 */
export type GpsStatus = "pending" | "active" | "denied" | "unavailable";

export interface DeviceLocation {
  position: { lat: number; lng: number; accuracy: number | null } | null;
  gpsStatus: GpsStatus;
  /** Ask for permission on demand (e.g. from a "turn on location" button). */
  request: () => Promise<void>;
}

const Ctx = createContext<DeviceLocation | null>(null);

export function useDeviceLocation(): DeviceLocation {
  return (
    useContext(Ctx) ?? { position: null, gpsStatus: "unavailable", request: async () => {} }
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

  async function request() {
    const services = await Location.hasServicesEnabledAsync().catch(() => false);
    if (!services) {
      setGpsStatus("unavailable");
      return;
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      setGpsStatus("denied");
      return;
    }
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
      if (existing && !existing.canAskAgain) {
        setGpsStatus("denied");
        return;
      }
      await request();
    })();
    return () => {
      cancelled = true;
      subRef.current?.remove();
      subRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptAllowed]);

  return <Ctx.Provider value={{ position, gpsStatus, request }}>{children}</Ctx.Provider>;
}
