import { createContext, useContext, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import LocationPrimer from "@/components/LocationPrimer";

/**
 * Native mirror of src/components/DeviceLocationContext.tsx.
 *
 * Owns the app's single location pipeline: one deliberate permission request,
 * then a live watch. Same `gpsStatus` vocabulary as the web so the shared
 * `useNextStop` hook works unchanged on both platforms.
 *
 * Unlike the web, the OS alert here is one-shot: iOS shows it once per install
 * and a "Don't Allow" is only reversible in Settings. So the mount effect no
 * longer fires it directly — it shows our own primer first (LocationPrimer)
 * and spends the OS prompt only on a user who already agreed.
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
      gpsStatus: "unavailable",
      enablePath: "none",
      request: async () => {},
    }
  );
}

/**
 * Whether the user has been through our primer. Remembered so that opening a
 * second trip doesn't re-nag someone who said "Not now" — but `request()`
 * clears it, so an explicit "turn on location" tap always gets through.
 *
 * SecureStore rather than AsyncStorage purely because it is already a
 * dependency (lib/auth uses it); this value is not a secret.
 */
const CONSENT_KEY = "location.primer.v1";
type Consent = "accepted" | "declined";

async function readConsent(): Promise<Consent | null> {
  try {
    const v = await SecureStore.getItemAsync(CONSENT_KEY);
    return v === "accepted" || v === "declined" ? v : null;
  } catch {
    // Unreadable keychain — treat as undecided and show the primer again.
    return null;
  }
}

async function writeConsent(v: Consent): Promise<void> {
  try {
    await SecureStore.setItemAsync(CONSENT_KEY, v);
  } catch {
    // Best effort. Worst case the primer reappears next launch, which is a
    // nag — never a wrong permission state.
  }
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
  const [enablePath, setEnablePath] = useState<EnablePath>("none");
  const [primerVisible, setPrimerVisible] = useState(false);
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
   * Spend the OS prompt. Only called once consent exists — either from the
   * primer or from an explicit "turn on location" tap.
   */
  async function askOs() {
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

  /**
   * Public escape hatch. Tapping a "turn on location" control IS consent, so
   * this skips the primer and overwrites a remembered "Not now" — otherwise
   * that choice would be a one-way door inside the app.
   */
  async function request() {
    setPrimerVisible(false);
    await writeConsent("accepted");
    await askOs();
  }

  function handleEnable() {
    setPrimerVisible(false);
    void (async () => {
      await writeConsent("accepted");
      await askOs();
    })();
  }

  function handleDecline() {
    setPrimerVisible(false);
    setEnablePath("prompt");
    setGpsStatus("denied");
    void writeConsent("declined");
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
      // iOS has already been asked and won't ask again. Showing the primer
      // here would promise a prompt that never arrives.
      if (existing && !existing.canAskAgain) {
        setEnablePath("settings");
        setGpsStatus("denied");
        return;
      }
      // From here on the OS alert is still spendable, so a "turn on location"
      // control is worth offering however the user answers the primer.
      setEnablePath("prompt");
      const consent = await readConsent();
      if (cancelled) return;
      if (consent === "declined") {
        setGpsStatus("denied");
        return;
      }
      if (consent === "accepted") {
        // Said yes before but the OS prompt never resolved (app killed
        // mid-alert, or a fresh install of a reinstalled app). Go straight
        // there — re-explaining would be repetitive.
        await askOs();
        return;
      }
      // Undecided: leave gpsStatus "pending" and let the primer decide.
      setPrimerVisible(true);
    })();
    return () => {
      cancelled = true;
      subRef.current?.remove();
      subRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptAllowed]);

  return (
    <Ctx.Provider value={{ position, gpsStatus, enablePath, request }}>
      {children}
      <LocationPrimer
        visible={primerVisible}
        onEnable={handleEnable}
        onDecline={handleDecline}
      />
    </Ctx.Provider>
  );
}
