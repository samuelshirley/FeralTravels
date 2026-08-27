import { useEffect } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  useFonts,
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
  Onest_700Bold,
  Onest_800ExtraBold,
} from "@expo-google-fonts/onest";
import { UnitsProvider } from "@/lib/units";
import { ErrorProvider } from "@/lib/errors";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

// Hold the native splash (purple, Finn) past the first JS frame. app/index.tsx
// releases it once it has decided whether to route to /trips or /sign-in, so
// the launch screen hands straight over to a real screen. Failures are ignored
// on purpose — this call must never be able to strand the app on the splash.
SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Root shell. Mirrors the providers the web mounts around every signed-in
 * page: units (+ the one-time timezone sync) and the single global error
 * surface. DeviceLocationProvider is deliberately NOT here — the web mounts it
 * only inside the trip workspace, so location is requested when it is actually
 * needed rather than on cold start.
 */
export default function RootLayout() {
  // Same five Onest weights the web requests in src/app/layout.tsx:7-12.
  const [fontsLoaded, fontError] = useFonts({
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Onest_700Bold,
    Onest_800ExtraBold,
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
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.bg },
              headerTintColor: theme.text,
              headerTitleStyle: { fontFamily: font.semibold },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: theme.bg },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            {/* trips/index draws its own header — see the note at the top of that file. */}
            <Stack.Screen name="trips/index" options={{ headerShown: false }} />
            <Stack.Screen name="trips/[tripId]" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
          </Stack>
        </UnitsProvider>
      </ErrorProvider>
    </SafeAreaProvider>
  );
}
