import { useEffect } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from "@expo-google-fonts/inter";
import { UnitsProvider } from "@/lib/units";
import { ErrorProvider } from "@/lib/errors";
import { configurePurchases } from "@/lib/purchases";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

// Hold the native splash (purple, Finn) past the first JS frame. app/index.tsx
// releases it once it has decided whether to route to /trips or /sign-in, so
// the launch screen hands straight over to a real screen. Failures are ignored
// on purpose — this call must never be able to strand the app on the splash.
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Configure RevenueCat once, at module scope, before the first render.
 *
 * Module scope rather than an effect because `Purchases.configure` is
 * synchronous, idempotent behind its own guard, and must have happened before
 * anything can call `getOfferings` — and a user can reach the paywall on the
 * very first screen. It does not block the splash: the async part (resolving
 * `users.id` and calling `logIn`) is fired and forgotten inside, and the actual
 * gate on a purchase is `requirePurchaserId` at the moment of buying.
 *
 * A build with no `EXPO_PUBLIC_REVENUECAT_IOS_KEY` no-ops here and the app
 * behaves exactly as it did before StoreKit existed.
 */
configurePurchases();

/**
 * Root shell. Mirrors the providers the web mounts around every signed-in
 * page: units (+ the one-time timezone sync) and the single global error
 * surface. DeviceLocationProvider is deliberately NOT here — the web mounts it
 * only inside the trip workspace, so location is requested when it is actually
 * needed rather than on cold start.
 */
export default function RootLayout() {
  // Same five Inter weights the web requests in src/app/layout.tsx.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  // Safety net. app/index.tsx lifts the splash the moment it has routed; this
  // only ever fires if that never happens (fonts that neither load nor error).
  // A blank purple screen forever is a worse failure than an unstyled one.
  useEffect(() => {
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 8000);
    return () => clearTimeout(t);
  }, []);

  // Hold the first frame until the faces are in memory — without this every
  // screen paints once in San Francisco and then reflows into Onest. This
  // normally sits *under* the still-visible native splash, so it is painted in
  // the splash purple rather than the app cream; a slow font fetch must not
  // flash a second background colour. `fontError` still lets the app through —
  // a failed font download should degrade to the system face, not a dead app.
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: theme.splash }} />;
  }

  return (
    <SafeAreaProvider>
      <ErrorProvider>
        <UnitsProvider>
          {/* Nocturne is a dark ground — the status bar glyphs have to be light. */}
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.bg },
              headerTintColor: theme.text,
              headerTitleStyle: { fontFamily: font.semibold },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: theme.bg },
            }}
          >
            {/*
              EVERY ROUTE IS DECLARED HERE, and every one either hides its header
              or gives it a human `title`. A native-stack header with neither
              falls back to the ROUTE NAME, and Expo Router route names are file
              patterns — so the UI renders `trips/[tripId]`, brackets and all.

              That is not hypothetical: it was the Settings back button, visible
              in the App Store screenshot set. The back button takes its label
              from the PREVIOUS screen's title, `trips/[tripId]` declared none,
              and the raw pattern leaked into a control the user reads. It was
              also far wider than any other back affordance in the app, which is
              what made it obvious in a screenshot and invisible in review.

              `src/lib/routeLabels.test.ts` fails if a route is added without an
              answer here.
            */}
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            {/* trips/index draws its own header — see the note at the top of that file. */}
            <Stack.Screen name="trips/index" options={{ headerShown: false }} />
            <Stack.Screen name="trips/[tripId]" options={{ headerShown: false }} />
            {/*
              Was missing entirely, which is the same bug one step further along:
              undeclared, so it took the default options, so it drew a native
              header titled "paywall" ON TOP of the Penny header the screen
              already draws for itself. Found by auditing this list rather than
              by anybody seeing it.
            */}
            <Stack.Screen name="paywall" options={{ headerShown: false }} />
            {/*
              "Back", not "Trip". Settings is pushed from BottomNav, TripHeader,
              StopsSection, trips/index and PlanRequiredOverlay — so it is
              reached from the trips LIST as often as from inside a trip, and
              "Back to trip" would be a lie on half of those paths.
            */}
            <Stack.Screen
              name="settings"
              options={{ title: "Settings", headerBackTitle: "Back" }}
            />
          </Stack>
        </UnitsProvider>
      </ErrorProvider>
    </SafeAreaProvider>
  );
}
