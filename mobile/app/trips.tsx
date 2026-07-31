import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { listTrips, isAuthError, type TripSummary } from "@/lib/api";
import { clearToken } from "@/lib/auth";

export default function Trips() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const rows = await listTrips();
      setTrips(rows.filter((t) => !t.is_template));
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/sign-in");
        return;
      }
      setError("Couldn't load your trips. Pull to retry.");
      setTrips((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function signOut() {
    await clearToken();
    router.replace("/sign-in");
  }

  if (trips === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#d4a24e" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#d4a24e" />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No trips yet</Text>
            <Text style={styles.emptyHint}>
              Trip creation from the app is coming next — for now, trips you plan on the web show
              up here.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardMeta}>
              {item.start_date_parsed} · {item.status}
            </Text>
          </View>
        )}
        contentContainerStyle={trips.length === 0 ? styles.emptyList : styles.list}
      />
      <Pressable onPress={signOut}>
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a1a",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#1a1a1a",
  },
  list: {
    padding: 16,
  },
  emptyList: {
    flexGrow: 1,
  },
  card: {
    backgroundColor: "#2a2a2a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#f5f0e8",
    marginBottom: 4,
  },
  cardMeta: {
    fontSize: 13,
    color: "#b8b0a4",
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#f5f0e8",
    marginBottom: 8,
  },
  emptyHint: {
    fontSize: 14,
    color: "#b8b0a4",
    textAlign: "center",
  },
  error: {
    color: "#e0705a",
    fontSize: 14,
    textAlign: "center",
    paddingTop: 12,
  },
  signOut: {
    color: "#6b6459",
    fontSize: 14,
    textAlign: "center",
    padding: 16,
  },
});
