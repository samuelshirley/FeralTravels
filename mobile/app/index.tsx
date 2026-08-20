import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { getToken } from "@/lib/auth";
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
 */
export default function Gate() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // getToken already swallows keychain failures and returns null, so a
      // signed-out result is the worst case here — never a hang.
      const token = await getToken();
      if (cancelled) return;
      router.replace(token ? "/trips" : "/sign-in");
      // Next frame, so the destination has painted before the splash lifts.
      requestAnimationFrame(() => {
        SplashScreen.hideAsync().catch(() => {});
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <View style={styles.container} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.splash },
});
