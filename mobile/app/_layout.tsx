import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
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

  // expo-splash-screen isn't a dependency, so instead of holding the native
  // splash we hold the first frame: paint the app background until the faces
  // are in memory. Without this every screen paints once in San Francisco and
  // then reflows into Onest. `fontError` still lets the app through — a failed
  // font download should degrade to the system face, not a blank screen.
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
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
            <Stack.Screen name="trips/index" options={{ title: "Your trips", headerBackVisible: false }} />
            <Stack.Screen name="trips/[tripId]" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
          </Stack>
        </UnitsProvider>
      </ErrorProvider>
    </SafeAreaProvider>
  );
}
