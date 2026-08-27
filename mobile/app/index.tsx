import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router, type Href } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { getToken } from "@/lib/auth";
import { listTrips } from "@/lib/api";
import { fetchEntitlement } from "@/lib/entitlement";
import { theme } from "@/lib/theme";

/**
 * Entry gate: route to /trips when a stored session exists, /sign-in when
 * not. The token might be expired — apiFetch clears it on any 401 and the
 * screens bounce back here, so the gate stays dumb and fast.
 *
 * The gate paints nothing of its own. _layout holds the native splash
 * (preventAutoHideAsync) and this screen releases it only once the route
 * decision is made, so the purple splash runs straight into /trips or
 * /sign-in. It used to render a cream "Feral Travels" title + spinner, which
 * read as a second, differently-coloured loading screen wedged between the
 * two. The purple fill below is a backstop for the frame between `replace`
 * and the destination's first paint — it must never be visible as a screen.
 *
 * It also owns ONE piece of product logic, and it owns it because it is the
 * only thing in the app that runs exactly once per launch: an account past its
 * seven days is sent to Penny's chat rather than to a list it cannot use.
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // getToken already swallows keychain failures and returns null, so a
      // signed-out result is the worst case here — never a hang.
      const token = await getToken();
      if (cancelled) return;
      if (!token) {
        go("/sign-in");
        return;
      }
      const blocked = await Promise.race([
        blockedDestination(),
        new Promise<Href | null>((resolve) =>
          setTimeout(() => resolve(null), LAUNCH_CHECK_TIMEOUT_MS)
        ),
      ]);
      if (cancelled) return;
      go(blocked ?? "/trips");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <View style={styles.container} />;
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
  // /api/me does NOT return a user id to compare against. Ordering is
  // most-recently-active first with templates last, so the head of this list is
  // the trip they were last in.
  const mine = trips.filter((t) => !t.is_template);
  // An account that never made a trip has no chat to be told in — chat_history
  // is trip-scoped — which is what /paywall exists for.
  return mine[0] ? `/trips/${mine[0].id}?chat=1` : "/paywall";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.splash },
});
