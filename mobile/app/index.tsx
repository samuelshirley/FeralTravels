import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { getToken } from "@/lib/auth";
import { theme } from "@/lib/theme";

/**
 * Entry gate: route to /trips when a stored session exists, /sign-in when
 * not. The token might be expired — /trips handles a 401 by clearing it and
 * bouncing back here, so the gate stays dumb and fast.
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
      <ActivityIndicator color={theme.primary} />
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
  title: {
    fontSize: 34,
    fontWeight: "700",
    color: theme.text,
  },
});
