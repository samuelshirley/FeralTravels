import { StyleSheet, Text, View, Pressable } from "react-native";
import { API_BASE_URL } from "@/lib/config";

export default function Welcome() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Feral Travels</Text>
      <Text style={styles.tagline}>
        Your overland copilot. Plan the route, find the fuel, just drive.
      </Text>

      <Pressable style={[styles.button, styles.buttonDisabled]} disabled>
        <Text style={styles.buttonText}>Sign in — coming next</Text>
      </Pressable>

      <Text style={styles.footnote}>
        API: {API_BASE_URL || "not configured (set EXPO_PUBLIC_API_URL)"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#1a1a1a",
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    color: "#f5f0e8",
    marginBottom: 12,
  },
  tagline: {
    fontSize: 16,
    color: "#b8b0a4",
    textAlign: "center",
    marginBottom: 48,
  },
  button: {
    backgroundColor: "#d4a24e",
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  footnote: {
    position: "absolute",
    bottom: 32,
    fontSize: 12,
    color: "#6b6459",
  },
});
