import { useEffect, useRef, useState } from "react";
import { AppState, Image, StyleSheet, View } from "react-native";
import { router, type Href } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Location from "expo-location";
import LocationPrimer from "@/components/LocationPrimer";
import {
  resolveLaunchLocation,
  type LaunchPermission,
  type LaunchLocationOutcome,
} from "@/shared/lib/launchLocation";
import { getToken } from "@/lib/auth";
import { listTrips } from "@/lib/api";
import { fetchEntitlement } from "@/lib/entitlement";
import { mostRecentlyActive } from "@/shared/lib/tripsListDates";
import { theme } from "@/lib/theme";

/**
 * Entry gate: route to /trips when a stored session exists, /sign-in when
 * not. The token might be expired — apiFetch clears it on any 401 and the
 * screens bounce back here, so the gate stays dumb and fast.
 *
 * The gate paints nothing of its own but the splash. _layout holds the native splash
 * (preventAutoHideAsync) and this screen releases it only once the route
 * decision is made, so the purple splash runs straight into /trips or
 * /sign-in. It used to render a cream "Feral Travels" title + spinner, which
 * read as a second, differently-coloured loading screen wedged between the
 * two. The purple fill below is a backstop for the frame between `replace`
 * and the destination's first paint — it must never be visible as a screen.
 *
 * It owns TWO pieces of product logic, because it is the only thing in the app
 * that runs exactly once per launch:
 *
 *  - LOCATION IS ASKED HERE, on the purple Finn splash (Sam's rule), and the
 *    app does not route anywhere until the user has answered iOS's own dialog,
 *    Allow or Don't Allow. When iOS has not been asked yet, LocationPrimer
 *    explains first and its only control, Continue, raises that dialog — App
 *    Review 5.1.1(iv) forbids a pre-prompt with a way past it. The whole
 *    decision is shared/lib/launchLocation.ts, tested in the root suite. While
 *    the primer is up this screen draws its own copy of the splash, because
 *    the native splash sits ABOVE React and would hide the sheet.
 *  - An account past its seven days is sent to Penny's chat rather than to a
 *    list it cannot use.
 *
 * That decision used to live in the trips list, latched behind a module-level
 * flag meaning "already done this app open". The flag was never reset, and a
 * module-level value lives as long as the JS runtime — which on iOS spans every
 * open until the OS actually terminates the process, not one. Tapping the icon
 * on a backgrounded app resumes that same runtime, so the second open and every
 * one after it silently skipped the redirect. Mounting is the honest signal:
 * this screen mounts once per launch, so there is nothing to latch and nothing
 * to reset.
 */

/**
 * How long a launch waits for the entitlement answer before giving up and
 * routing to the trips list anyway.
 *
 * The check costs a round trip and it happens under the splash, so it must be
 * bounded: a phone on a dying connection has to reach the app, not sit on a
 * purple screen. Falling through is safe — the trips list and the trip
 * workspace both ask again and cover themselves, and every route that spends
 * money gates itself server-side regardless.
 */
const LAUNCH_CHECK_TIMEOUT_MS = 2500;

export default function Gate() {
  const [primerVisible, setPrimerVisible] = useState(false);
  const continueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Both run at once: the route decision costs a round trip, and it is
      // made while the user reads the primer. Neither alone lets launch go on.
      const located = askLocationAtLaunch({
        showPrimer: () =>
          new Promise<void>((resolve) => {
            continueRef.current = resolve;
            if (cancelled) return;
            setPrimerVisible(true);
            // The sheet is React; the native splash covers React. Lift it —
            // this screen's own splash copy is what shows under the sheet.
            SplashScreen.hideAsync().catch(() => {});
          }),
        hidePrimer: () => {
          continueRef.current = null;
          if (!cancelled) setPrimerVisible(false);
        },
      });
      const [, destination] = await Promise.all([located, routeDestination()]);
      if (cancelled) return;
      go(destination);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      {/* The native splash, redrawn: same art, same 300pt width, centred on the
          same purple — so lifting the native one changes nothing on screen. */}
      <Image
        source={require("../assets/splash-icon.png")}
        style={styles.splashArt}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      <LocationPrimer visible={primerVisible} onContinue={() => continueRef.current?.()} />
    </View>
  );
}

/** Where launch goes once the location question is settled. */
async function routeDestination(): Promise<Href> {
  // getToken already swallows keychain failures and returns null, so a
  // signed-out result is the worst case here — never a hang.
  const token = await getToken();
  if (!token) return "/sign-in";
  const blocked = await Promise.race([
    blockedDestination(),
    new Promise<Href | null>((resolve) =>
      setTimeout(() => resolve(null), LAUNCH_CHECK_TIMEOUT_MS)
    ),
  ]);
  return blocked ?? "/trips";
}

function toLaunchPermission(r: Location.LocationPermissionResponse): LaunchPermission {
  return { status: r.status as LaunchPermission["status"], canAskAgain: r.canAskAgain };
}

/**
 * expo-location, AppState and the primer, handed to the shared decision. The
 * only `requestForegroundPermissionsAsync` reachable at launch is here, after
 * Continue.
 */
function askLocationAtLaunch(ui: {
  showPrimer: () => Promise<void>;
  hidePrimer: () => void;
}): Promise<LaunchLocationOutcome> {
  return resolveLaunchLocation({
    read: async () => toLaunchPermission(await Location.getForegroundPermissionsAsync()),
    servicesEnabled: () => Location.hasServicesEnabledAsync(),
    request: async () => toLaunchPermission(await Location.requestForegroundPermissionsAsync()),
    showPrimer: ui.showPrimer,
    hidePrimer: ui.hidePrimer,
    onForeground: (cb) => {
      const sub = AppState.addEventListener("change", (next) => {
        if (next === "active") cb();
      });
      return () => sub.remove();
    },
    // Never let the question strand the launch: the shared code already turns
    // every native failure into "go on", this is the belt to those braces.
  }).catch((): LaunchLocationOutcome => "unaskable");
}

function go(href: Href) {
  router.replace(href);
  // Next frame, so the destination has painted before the splash lifts.
  requestAnimationFrame(() => {
    SplashScreen.hideAsync().catch(() => {});
  });
}

/**
 * Where a blocked account should land, or null when it is not blocked (or we
 * could not find out).
 *
 * A null verdict means the lookup failed and is treated as entitled on purpose:
 * a phone in a tunnel must not paywall a paying customer. Being wrong in this
 * direction costs one rejected request; being wrong in the other locks someone
 * out of the app they paid for.
 */
async function blockedDestination(): Promise<Href | null> {
  const verdict = await fetchEntitlement();
  if (!verdict || verdict.entitled) return null;

  // Past the wall the user meets Penny, not a list. She has the whole story —
  // the trial, the two prices, the button — and she has it in the transcript
  // they already know, so the block reads as her telling them rather than as
  // the app locking a door.
  const trips = await listTrips().catch(() => []);
  // Filtered on `is_template` rather than on ownership: /api/trips returns the
  // caller's own trips plus the shared demo templates and nothing else, and
  // /api/me does NOT return a user id to compare against. The list is ordered
  // by start date, so its head is not necessarily the trip they were last in —
  // `mostRecentlyActive` reads `last_activity_at` to find that one.
  const last = mostRecentlyActive(trips.filter((t) => !t.is_template));
  // An account that never made a trip has no chat to be told in — chat_history
  // is trip-scoped — which is what /paywall exists for.
  return last ? `/trips/${last.id}?chat=1` : "/paywall";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.splash,
    alignItems: "center",
    justifyContent: "center",
  },
  // app.config.js: expo-splash-screen imageWidth 300, resizeMode contain, on a
  // square 1024px master.
  splashArt: { width: 300, height: 300 },
});
