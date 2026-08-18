import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { getToken } from "@/lib/auth";
import { Spinner } from "@/components/ui";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Entry gate: route to /trips when a stored session exists, /sign-in when
 * not. The token might be expired — apiFetch clears it on any 401 and the
 * screens bounce back here, so the gate stays dumb and fast.
 */
export default function Gate() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (cancelled) return;
      router.replace(token ? "/trips" : "/sign-in");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Feral Travels</Text>
      <Spinner />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: theme.bg,
  },
  title: { fontSize: 34, fontFamily: font.bold, color: theme.text },
});
