import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, StyleSheet, Switch, Text, View } from "react-native";
import * as Location from "expo-location";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Location permission, in Settings — as a TOGGLE.
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
 *
 * THE TWO DIRECTIONS ARE NOT THE SAME, and the switch is honest about it:
 *
 *   off → on   `requestForegroundPermissionsAsync` — the iOS dialog appears.
 *              Once iOS has spent that dialog (`canAskAgain: false`) the only
 *              way on is the Settings app, so the flip hands the user there.
 *   on → off   No app can revoke its own permission. The flip opens the
 *              Settings app, where the real control is, and the switch does
 *              not animate off until iOS says so (re-read on foreground).
 *
 * The web section is live in ONE direction only, because a page has no
 * equivalent of `Linking.openSettings()`; see src/components/LocationSection.tsx.
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

  const onToggle = useCallback(
    async (next: boolean) => {
      if (busy) return;
      // on → off, or on from a spent dialog: only the Settings app can do it.
      if (!next || state === "settings") {
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
    },
    [busy, state, read]
  );

  if (state === "loading" || state === "unavailable") return null;

  const granted = state === "granted";
  const hint = granted
    ? "To turn it off, use Feral Travels in the Settings app."
    : state === "settings"
      ? "iOS won’t ask again — turn it on under Feral Travels in the Settings app."
      : null;

  return (
    <View style={styles.section} testID="settings-location-section">
      <Text style={styles.title}>Location</Text>
      <Text style={styles.blurb}>
        Lets Penny plan from where you actually are, and puts you on the map.
      </Text>

      <View style={styles.row}>
        <Text style={styles.status} testID="settings-location-status">
          {granted ? "On" : "Off"}
        </Text>
        <Switch
          value={granted}
          disabled={busy}
          onValueChange={(v) => void onToggle(v)}
          accessibilityLabel="Location"
          testID="settings-location-enable"
          trackColor={{ true: theme.primary, false: theme.borderStrong }}
          thumbColor={theme.text}
          ios_backgroundColor={theme.borderStrong}
        />
      </View>

      {hint ? (
        <Text style={styles.hint} testID="settings-location-hint">
          {hint}
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
  status: { fontFamily: font.medium, fontSize: 15, color: theme.text },
  hint: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    lineHeight: 16,
    marginTop: 10,
  },
});
