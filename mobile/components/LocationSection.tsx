import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Location permission, in Settings.
 *
 * WHY IT IS HERE AND NOT ONLY ON THE TRIP SCREEN. `LegCard` offers a way back
 * from a denied permission, but only inside an expanded day of a live trip —
 * so a driver who tapped "Not now" once had to know to open a day to find it
 * again. Settings is where someone goes when they think a permission is wrong.
 *
 * It reads the permission DIRECTLY rather than through `useDeviceLocation`:
 * that provider is mounted per trip screen (deliberately, so a cold start
 * never prompts), and Settings sits outside it.
 *
 * `getForegroundPermissionsAsync` READS without prompting, which is what a
 * settings row must do — a screen that raises a system dialog just by being
 * opened is the behaviour this app has been careful to avoid.
 */
type PermState = "loading" | "granted" | "prompt" | "settings" | "unavailable";

export default function LocationSection() {
  const [state, setState] = useState<PermState>("loading");
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const res = await Location.getForegroundPermissionsAsync();
      if (res.granted) setState("granted");
      // `canAskAgain: false` is iOS saying the dialog is spent — the only way
      // back is the Settings app, which is exactly the branch below.
      else if (res.canAskAgain) setState("prompt");
      else setState("settings");
    } catch {
      setState("unavailable");
    }
  }, []);

  useEffect(() => {
    void read();
    /*
     * Re-read when the app comes back to the foreground. Without this, a user
     * who taps through to iOS Settings, grants location and returns sees this
     * row still claiming it is off — the one moment they are most certain the
     * app is broken.
     */
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void read();
    });
    return () => sub.remove();
  }, [read]);

  const onPress = useCallback(async () => {
    if (state === "settings") {
      void Linking.openSettings();
      return;
    }
    if (state !== "prompt") return;
    setBusy(true);
    try {
      await Location.requestForegroundPermissionsAsync();
    } finally {
      setBusy(false);
      void read();
    }
  }, [state, read]);

  if (state === "loading" || state === "unavailable") return null;

  const granted = state === "granted";

  return (
    <View style={styles.section} testID="settings-location-section">
      <Text style={styles.title}>Location</Text>
      <Text style={styles.blurb}>
        Lets Penny plan from where you actually are, and puts you on the map.
      </Text>

      <View style={styles.row}>
        <View style={styles.statusWrap}>
          <View style={[styles.dot, granted ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.status} testID="settings-location-status">
            {granted ? "On" : "Off"}
          </Text>
        </View>

        {!granted ? (
          <Pressable
            onPress={() => void onPress()}
            disabled={busy}
            accessibilityRole="button"
            testID="settings-location-enable"
            style={[styles.button, busy && styles.buttonBusy]}
          >
            <Text style={styles.buttonText}>
              {state === "settings" ? "Open Settings" : "Turn on"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {state === "settings" ? (
        <Text style={styles.hint}>
          iOS won&apos;t ask again — turn it on under Feral Travels in the Settings app.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingVertical: 20 },
  title: { fontSize: 17, fontFamily: font.medium, color: theme.text, marginBottom: 6 },
  blurb: {
    fontFamily: font.regular,
    fontSize: 13,
    color: theme.muted,
    lineHeight: 20,
    marginBottom: 14,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  statusWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.primary },
  dotOff: { backgroundColor: theme.borderStrong },
  status: { fontFamily: font.medium, fontSize: 15, color: theme.text },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: theme.primary,
    backgroundColor: theme.primaryTint,
    borderRadius: theme.radiusMd,
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { fontFamily: font.medium, fontSize: 13, color: theme.accent300 },
  hint: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    lineHeight: 16,
    marginTop: 10,
  },
});
