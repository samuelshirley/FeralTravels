import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#1a1a1a" },
          headerTintColor: "#f5f0e8",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#1a1a1a" },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: "Feral Travels" }} />
        <Stack.Screen name="trips" options={{ title: "Your trips", headerBackVisible: false }} />
      </Stack>
    </>
  );
}
