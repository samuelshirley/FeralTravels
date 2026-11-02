import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import FeatureRequestCard from "@/components/FeatureRequestCard";
import { ChevronLeftIcon } from "@/components/icons";
import { Button, Centered, Spinner } from "@/components/ui";
import {
  ApiError,
  isAuthError,
  listFeatureRequests,
  setFeatureRequestVote,
} from "@/lib/api";
import { useErrors } from "@/lib/errors";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import {
  optimisticVote,
  votingOpen,
  VOTING_CLOSED_CODE,
  type FeatureRequestView,
  type VoteResult,
} from "@/shared/lib/featureRequests";

/**
 * Feature requests (Account menu → Feature requests). Native only: the web app
 * is admin-only, and the admin writes these at /admin/feature-requests.
 *
 * The server sends the list in display order and this screen never re-sorts
 * it, so a card does not move out from under the thumb that just voted on it.
 * A pull to refresh picks up the new order.
 *
 * Voting is optimistic: the count changes on tap, the server's answer then
 * replaces it, and a failure puts back the last count the server confirmed and
 * says why. Taps can overlap (a quick vote-unvote), so only the answer to the
 * LATEST tap on a request is drawn; earlier answers just update what is known
 * to be confirmed.
 */
export default function FeatureRequestsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { notify } = useErrors();

  const [requests, setRequests] = useState<FeatureRequestView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /** Last server-confirmed vote state per request — what a failed tap reverts to. */
  const confirmed = useRef(new Map<string, VoteResult>());
  /** Tap counter per request; only the newest tap's answer is drawn. */
  const seq = useRef(new Map<string, number>());

  const load = useCallback(async () => {
    try {
      const list = await listFeatureRequests();
      confirmed.current = new Map(list.map((r) => [r.id, { voteCount: r.voteCount, votedByMe: r.votedByMe }]));
      setRequests(list);
      setLoadFailed(false);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/sign-in");
        return;
      }
      // Drawn inline below, with a retry — never a blank screen.
      setLoadFailed(true);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const patch = useCallback((id: string, next: VoteResult) => {
    setRequests((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...next } : r)) : prev));
  }, []);

  const vote = useCallback(
    async (row: FeatureRequestView, next: boolean) => {
      if (!votingOpen(row.status)) return;
      const mine = (seq.current.get(row.id) ?? 0) + 1;
      seq.current.set(row.id, mine);
      patch(row.id, optimisticVote(row, next));

      try {
        const result = await setFeatureRequestVote(row.id, next);
        confirmed.current.set(row.id, result);
        if (seq.current.get(row.id) === mine) patch(row.id, result);
      } catch (err) {
        if (seq.current.get(row.id) !== mine) return;
        const back = confirmed.current.get(row.id);
        if (back) patch(row.id, back);
        if (isAuthError(err)) {
          router.replace("/sign-in");
          return;
        }
        if (err instanceof ApiError && err.status === 409 && err.message === VOTING_CLOSED_CODE) {
          notify("Voting on this one has closed.");
          void load();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          notify("That request has been removed.");
          void load();
          return;
        }
        notify(
          err instanceof ApiError && err.status === 0
            ? "Your vote didn't go through. Check your connection and try again."
            : "Your vote didn't go through. Try again."
        );
      }
    },
    [load, notify, patch, router]
  );

  /*
   * The screen's own header — see the note on this route in app/_layout.tsx
   * for why it is not the native stack's. "Back", not "Trips": the menu that
   * opens this is on the trips list AND inside a trip. A cold deep link has
   * nothing to go back to, so that one goes to the trips list.
   */
  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
      <Pressable
        testID="feature-requests-back"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/trips"))}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
        style={styles.backLink}
      >
        <ChevronLeftIcon color={theme.text} />
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>
      <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
        Feature requests
      </Text>
      {/* Balances the back control so the title centres on the screen. */}
      <View style={styles.headerSide} />
    </View>
  );

  if (requests === null) {
    return (
      <View style={styles.root}>
        {header}
        {loadFailed ? (
          <Centered>
            <Text style={styles.message}>Couldn&apos;t load feature requests.</Text>
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => {
                setLoadFailed(false);
                void load();
              }}
              style={styles.retry}
            />
          </Centered>
        ) : (
          <Centered>
            <Spinner size="large" />
          </Centered>
        )}
      </View>
    );
  }

  const active = requests.filter((r) => votingOpen(r.status));
  const closed = requests.filter((r) => !votingOpen(r.status));

  return (
    <View style={styles.root}>
      {header}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 40 + insets.bottom }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
        }
        testID="feature-requests-list"
      >
        {requests.length === 0 ? <Text style={styles.message}>No feature requests yet.</Text> : null}
        {active.map((r) => (
          <FeatureRequestCard key={r.id} request={r} onVote={(v) => void vote(r, v)} />
        ))}
        {closed.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>NOT DOING</Text>
            {closed.map((r) => (
              <FeatureRequestCard key={r.id} request={r} onVote={() => {}} />
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  backLink: { width: 72, flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, fontFamily: font.bold, color: theme.text },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: font.semibold,
    color: theme.text,
  },
  headerSide: { width: 72 },
  content: { paddingTop: 16, paddingHorizontal: 14, gap: 10 },
  sectionLabel: {
    marginTop: 14,
    fontFamily: font.semibold,
    fontSize: 9.5,
    letterSpacing: 0.8,
    color: theme.subtle,
  },
  message: { fontFamily: font.regular, fontSize: 14, color: theme.muted, textAlign: "center" },
  retry: { marginTop: 14, alignSelf: "center" },
});
