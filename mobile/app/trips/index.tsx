import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AnnouncementModal from "@/components/AnnouncementModal";
import SupportModal from "@/components/SupportModal";
import TripCard from "@/components/TripCard";
import { Button, Centered, Eyebrow, Spinner } from "@/components/ui";
import { PencilEditTripsIcon } from "@/components/icons";
import {
  cloneTrip,
  createTrip,
  getMe,
  isAuthError,
  listTrips,
  type Me,
} from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { fetchEntitlement, type EntitlementPayload } from "@/lib/entitlement";
import PlanRequiredOverlay from "@/components/PlanRequiredOverlay";
import AccountButton from "@/components/AccountButton";
import { useIdentity } from "@/lib/identity";
import { theme, shadow } from "@/lib/theme";
import type { Trip } from "@/shared/types/trip";
import { todayISO } from "@/shared/lib/dates";
import { isTripCompleted } from "@/shared/lib/tripCompletion";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/app/trips/page.tsx + TripsList.tsx + NewTripButton.tsx.
 *
 * The web splits the same `/api/trips` payload server-side; here the split
 * happens on the client because the route returns the caller's own trips AND
 * the shared demo templates in one list. Everything else — copy, ordering,
 * edit-mode affordance, the pulsing "+ New trip" cue — is the web's.
 */

/** `/api/me` returns the user row; lib/api's Me only declares the fields the
 *  settings screen needed, so widen it here instead of editing that client. */
type MeWithId = Me & { id?: string };

/**
 * This screen draws its own header instead of using the native stack's.
 *
 * It used to render the account avatar as `headerRight` of the UIKit navigation
 * bar. Built against the iOS 26 SDK, UIKit puts a 44pt Liquid Glass background
 * behind every nav-bar button item — so the app's own 32pt circle sat floating
 * inside a second, larger circle it never drew, and the 2pt nudge that used to
 * live here (compensating for the 16pt UIKit layout margin against this page's
 * 14pt gutter) pushed it visibly off that circle's centre. It read as a
 * lopsided avatar; the avatar was fine.
 *
 * react-native-screens 4.16 exposes no way to suppress that background on a
 * header item, and the same trap waits for any custom round control put there.
 * TripHeader has always drawn its own bar and has always rendered this avatar
 * correctly — so this screen now does the same, and the two headers agree.
 */

/**
 * "Has this app session already put a blocked user in front of Penny?"
 *
 * Module scope, not a ref, and that is the whole point: `router.replace` into
 * the trip UNMOUNTS this screen, so a ref would be back to `false` the moment
 * they navigated to the trips list — and every attempt to reach the list would
 * bounce straight back into the chat they just left. A module-level flag lives
 * as long as the JS runtime does, which is the same span as "this app open".
 *
 * Reset on sign-out so the next account gets its own first-open redirect.
 */
let sentToPennyThisSession = false;

type Row =
  | { key: string; kind: "empty" }
  | { key: string; kind: "templatesHeader" }
  | { key: string; kind: "trip"; trip: Trip; isTemplate: boolean };

export default function TripsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [meId, setMeId] = useState<string | null>(null);
  const [me, setMe] = useState<MeWithId | null>(null);
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [cloning, setCloning] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  /**
   * The server's verdict, held rather than acted on and forgotten, because the
   * overlay below needs the prices and the copy that came with it. Null means
   * "couldn't ask" and never blocks — see PlanRequiredOverlay.
   */
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);

  /**
   * One auto-create per mount, and only ever one.
   *
   * The web page deliberately does NOT do this — its comment says so, and for
   * the web it is right: a browser tab that silently creates a row on load is
   * surprising. On a phone it is the opposite. The app is a single-purpose
   * thing you open to plan a drive, and an empty list with a button on it is a
   * worse first screen than Penny already talking to you. That is the whole
   * divergence, and it is intentional.
   *
   * The ref is what keeps it from becoming a trip factory: `load()` re-runs on
   * every focus, so without it, deleting your only trip and navigating back
   * would create another, and another.
   */
  const autoCreated = useRef(false);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (!isAuthError(err)) return false;
      router.replace("/sign-in");
      return true;
    },
    [router]
  );

  const load = useCallback(async () => {
    try {
      const [tripsRes, meRes, verdict] = await Promise.all([
        listTrips(),
        getMe() as Promise<MeWithId>,
        fetchEntitlement(),
      ]);
      setTrips(tripsRes);
      setMe(meRes);
      setMeId(meRes.id ?? null);
      setEntitlement(verdict);

      const mine = meRes.id
        ? tripsRes.filter((t) => t.user_id === meRes.id)
        : tripsRes.filter((t) => !t.is_template);

      // Past the wall: the user meets Penny, not a list. She has the whole
      // story — the trial, the two prices, the button — and she has it in the
      // transcript they already know, so the block reads as her telling them
      // rather than as the app locking a door.
      //
      // A null verdict means the lookup failed, and it is treated as
      // entitled on purpose: a phone in a tunnel must not paywall a paying
      // customer. Every route that spends money gates itself server-side, so
      // being wrong in this direction costs one rejected request and being
      // wrong in the other locks someone out of the app they paid for.
      if (verdict && !verdict.entitled) {
        // Once per app open. `load()` re-runs on every focus, and a second
        // redirect would mean the trips list could never be reached at all —
        // they would be thrown back into the chat the instant they left it.
        if (!sentToPennyThisSession) {
          sentToPennyThisSession = true;
          // `listTrips` comes back most-recently-active first (templates last),
          // so the head of `mine` is the trip they were last in. An account
          // that never made one has no chat to be told in — chat_history is
          // trip-scoped — which is what /paywall exists for.
          const latest = mine[0];
          router.replace(latest ? `/trips/${latest.id}?chat=1` : "/paywall");
          return;
        }
        // They came back here deliberately. Draw the list and cover it.
        return;
      }

      if (mine.length === 0 && !autoCreated.current) {
        autoCreated.current = true;
        const trip = await createTrip();
        router.replace(`/trips/${trip.id}`);
        return;
      }
    } catch (err) {
      if (!handleAuthError(err)) {
        // Non-auth failures already surfaced through the global error notifier.
        setTrips((prev) => prev ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [handleAuthError, router]);

  // Refetch on focus, not just on mount: the web page is a server component
  // that re-renders when the user navigates back from a trip workspace, so a
  // trip renamed by Penny shows its new name the moment you return.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const all = trips ?? [];
  // Same predicates as the web page. If /api/me ever stops returning an id we
  // fall back to "templates are the demo section, everything else is mine",
  // which is how the payload is shaped anyway.
  const myTrips = meId ? all.filter((t) => t.user_id === meId) : all.filter((t) => !t.is_template);
  const templates = meId
    ? all.filter((t) => t.is_template && t.user_id !== meId)
    : all.filter((t) => t.is_template);

  const hasAnything = myTrips.length > 0 || templates.length > 0;

  const rows: Row[] = [];
  if (!loading && myTrips.length === 0) rows.push({ key: "empty", kind: "empty" });
  for (const trip of myTrips) rows.push({ key: trip.id, kind: "trip", trip, isTemplate: false });
  if (templates.length > 0) {
    rows.push({ key: "templatesHeader", kind: "templatesHeader" });
    for (const trip of templates) rows.push({ key: trip.id, kind: "trip", trip, isTemplate: true });
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    // Small delay so the spinner is visible to the user even when the network
    // round trip is fast — otherwise the pull feels like it did nothing.
    await new Promise((r) => setTimeout(r, 350));
    setRefreshing(false);
  }

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setCreateErr(null);
    try {
      // No name — the server assigns the placeholder and Penny renames later.
      const trip = await createTrip();
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      if (!handleAuthError(err)) {
        setCreateErr(err instanceof Error ? err.message : "Failed to create trip");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleClone(id: string) {
    setCloning(id);
    try {
      const trip = await cloneTrip(id);
      router.push(`/trips/${trip.id}`);
    } catch (err) {
      handleAuthError(err);
    } finally {
      setCloning(null);
    }
  }

  function handleTripDeleted(id: string) {
    setTrips((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
  }

  async function handleSignOut() {
    setMenuOpen(false);
    // The next account to sign in on this process gets its own first-open
    // redirect rather than inheriting this one's.
    sentToPennyThisSession = false;
    await clearToken();
    router.replace("/sign-in");
  }

  const identity = useIdentity();
  const displayName = identity.name;
  const displayEmail = identity.email;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        {/* Spacer the same width as the avatar, so the title centres on the
            screen rather than on the space the avatar leaves behind. */}
        <View style={styles.headerSpacer} />
        <Text style={styles.headerTitle}>Your trips</Text>
        <AccountButton
          email={displayEmail}
          image={identity.image}
          onPress={() => setMenuOpen(true)}
        />
      </View>

      <AnnouncementModal />

      {loading && trips === null ? (
        <Centered>
          <Spinner size="large" />
        </Centered>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
          ListHeaderComponent={
            <View>
              <View style={styles.pageHeader}>
                <View style={styles.pageHeaderText}>
                  <Eyebrow>YOUR TRIPS</Eyebrow>
                  <Text style={styles.pageTitle}>Trips</Text>
                </View>
                <NewTripButton
                  busy={creating}
                  onPress={handleCreate}
                  emphasize={myTrips.length === 0}
                />
              </View>

              {createErr ? (
                <Text accessibilityRole="alert" style={styles.createErr}>
                  {createErr}
                </Text>
              ) : null}

              {hasAnything ? (
                <View style={styles.editRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: editMode }}
                    onPress={() => setEditMode((v) => !v)}
                    style={[styles.editPill, editMode && styles.editPillOn]}
                  >
                    <PencilEditTripsIcon color={editMode ? theme.accentWarm : theme.muted} />
                    <Text style={[styles.editPillText, editMode && styles.editPillTextOn]}>
                      {editMode ? "DONE" : "EDIT TRIPS"}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === "empty") {
              return (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>
                    You don&apos;t have any trips yet. Use{" "}
                    <Text style={styles.emptyStrong}>+ New trip</Text> above to get started.
                  </Text>
                </View>
              );
            }
            if (item.kind === "templatesHeader") {
              return (
                <View style={styles.templatesHeader}>
                  <Eyebrow>DEMO / TEMPLATES</Eyebrow>
                </View>
              );
            }
            const { trip, isTemplate } = item;
            return (
              <TripCard
                id={trip.id}
                name={trip.name}
                startDate={trip.start_date}
                endDate={trip.end_date}
                isTemplate={isTemplate}
                // On a phone the runtime zone IS the driver's zone (the web
                // server runs in UTC and has to read the stored preference), so
                // todayISO() is already their wall clock. Templates are dated in
                // the past and are never "over" — they are something to clone,
                // not a trip anyone drove.
                completed={!isTemplate && isTripCompleted(trip.last_day_iso, todayISO())}
                // The web only wires delete on template cards for admins
                // (`canDeleteTemplates`). The app has no admin surface, so
                // templates are never deletable here.
                editMode={isTemplate ? false : editMode}
                showClone={isTemplate}
                onCloneClick={handleClone}
                cloneBusy={cloning === trip.id}
                onDeleted={handleTripDeleted}
              />
            );
          }}
        />
      )}

      {/* Web shows a full-screen LoadingOverlay while the clone runs. */}
      <Modal visible={cloning != null} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <Spinner size="large" />
            <Text style={styles.overlayText}>Cloning trip…</Text>
          </View>
        </View>
      </Modal>

      <AccountMenu
        open={menuOpen}
        top={insets.top + 52}
        name={displayName}
        email={displayEmail}
        onClose={() => setMenuOpen(false)}
        onSettings={() => {
          setMenuOpen(false);
          router.push("/settings");
        }}
        onSupport={() => {
          setMenuOpen(false);
          setSupportOpen(true);
        }}
        onSignOut={handleSignOut}
      />

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />

      {/* Last child, so it covers the header and the list without either being
          unmounted — the trips stay on screen behind it. */}
      <PlanRequiredOverlay
        entitlement={entitlement}
        onBackToPenny={() => {
          const latest = myTrips[0];
          router.replace(latest ? `/trips/${latest.id}?chat=1` : "/paywall");
        }}
        onEntitled={setEntitlement}
      />
    </>
  );
}

/**
 * "+ New trip" with the web's pulsing corner cue (.new-trip-corner-cue). The
 * cue only appears for users with zero trips — it is the one piece of
 * onboarding affordance on this screen, so it is worth the Animated loop.
 */
function NewTripButton({
  busy,
  emphasize,
  onPress,
}: {
  busy: boolean;
  emphasize: boolean;
  onPress: () => void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  // Mirrors the web's `prefers-reduced-motion` guard: the cue stays visible
  // but stops moving.
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (!cancelled) setReduceMotion(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const animate = emphasize && !busy && !reduceMotion;

  useEffect(() => {
    if (!animate) {
      pulse.setValue(0);
      return;
    }
    // 1.25s round trip, ease-in-out — same timing as the CSS keyframes.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 625,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 625,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [animate, pulse]);

  return (
    <View style={styles.newTripWrap}>
      <Button label="+ New trip" onPress={onPress} busy={busy} style={styles.newTripButton} />
      {emphasize && !busy ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.cue,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
              ],
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/**
 * Mirrors AppNavbar's account dropdown, as a sheet anchored under the header.
 *
 * Admin is deliberately NOT ported: the /admin guards reject bearer tokens, so
 * the link would only ever 401 from the app.
 */
function AccountMenu({
  open,
  top,
  name,
  email,
  onClose,
  onSettings,
  onSupport,
  onSignOut,
}: {
  open: boolean;
  top: number;
  name: string | null;
  email: string | null;
  onClose: () => void;
  onSettings: () => void;
  onSupport: () => void;
  onSignOut: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.menuBackdrop} onPress={onClose}>
        {/* Swallow taps inside the panel so they don't dismiss the menu. */}
        <Pressable style={[styles.menuPanel, { top }]} onPress={() => {}}>
          {name || email ? (
            <View style={styles.menuIdentity}>
              {/* Native counterpart of the web navbar's hover card: a phone has
                  no hover, so the address is labelled here instead. */}
              <Text style={styles.menuIdentityLabel}>SIGNED IN AS</Text>
              {name ? <Text style={styles.menuName}>{name}</Text> : null}
              {email ? (
                <Text style={styles.menuEmail} numberOfLines={1}>
                  {email}
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* This screen IS the trips list, so "Trips" just dismisses. */}
          <Pressable style={styles.menuItem} onPress={onClose}>
            <Text style={styles.menuItemText}>Trips</Text>
          </Pressable>
          <Pressable style={[styles.menuItem, styles.menuItemDivided]} onPress={onSettings}>
            <Text style={styles.menuItemText}>Settings</Text>
          </Pressable>
          <Pressable style={[styles.menuItem, styles.menuItemDivided]} onPress={onSupport}>
            <Text style={styles.menuItemText}>Contact Support</Text>
          </Pressable>
          <Pressable style={[styles.menuItem, styles.menuItemDivided]} onPress={onSignOut}>
            <Text style={[styles.menuItemText, styles.menuItemDanger]}>Sign out</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  listContent: {
    // src/app/layout.tsx:178 — .page-main { padding: 20px 14px 96px } ≤767px.
    // The 96px bottom is web headroom for the fixed BottomNav, which this
    // screen does not mount, so the native list keeps its own 40.
    paddingTop: 20,
    paddingHorizontal: 14,
    paddingBottom: 40,
  },
  pageHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    // src/app/layout.tsx:180 — .page-header { margin-bottom: 16px; gap: 10px }
    gap: 10,
    marginBottom: 16,
  },
  pageHeaderText: { flexShrink: 1, minWidth: 0 },
  // src/app/layout.tsx:179 — .page-title { font-size: 22px } ≤767px.
  pageTitle: { fontSize: 22, fontFamily: font.bold, color: theme.text },
  createErr: { fontFamily: font.regular, fontSize: 12, color: theme.danger, textAlign: "right", marginBottom: 8 },
  newTripWrap: { position: "relative" },
  newTripButton: { paddingVertical: 8, paddingHorizontal: 16 },
  cue: {
    position: "absolute",
    top: -4,
    left: -4,
    width: 12,
    height: 12,
    borderRadius: 4,
    backgroundColor: theme.accentWarm,
  },
  editRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 12 },
  editPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  editPillOn: {
    // src/app/trips/TripsList.tsx:88 hard-codes this border literal.
    borderColor: "rgba(201, 123, 99, 0.45)",
    backgroundColor: theme.accentWarmMuted,
  },
  editPillText: { fontFamily: font.regular, fontSize: 12, letterSpacing: 0.6, color: theme.muted },
  editPillTextOn: { color: theme.accentWarm },
  emptyBox: {
    padding: 20,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.borderStrong,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
    marginBottom: 20,
  },
  emptyText: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: theme.muted },
  emptyStrong: { color: theme.text, fontFamily: font.bold },
  templatesHeader: { marginTop: 20, marginBottom: 10 },
  overlay: {
    flex: 1,
    // src/components/Spinner.tsx:48 (LoadingOverlay) — var(--tp-overlay)
    backgroundColor: theme.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  overlayCard: {
    backgroundColor: theme.surface,
    borderRadius: theme.radiusMd,
    paddingVertical: 24,
    paddingHorizontal: 32,
    alignItems: "center",
    gap: 12,
    ...shadow.md,
  },
  overlayText: { fontFamily: font.regular, fontSize: 14, color: theme.text },
  /**
   * This screen's own header bar. The horizontal padding is 14 — the same
   * `listContent` gutter the "+ New trip" button and the trip cards use — so
   * the avatar now lines up with the column beneath it by construction, which
   * is what the old -2pt nudge was reaching for against UIKit's 16pt margin.
   */
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
    backgroundColor: theme.bg,
  },
  /** Balances the 32pt avatar so `headerTitle` centres on the screen. */
  headerSpacer: { width: 32 },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: font.semibold,
    color: theme.text,
  },
  // Native-only: the web account menu closes on outside-mousedown with no
  // visible scrim, so this tint has no web counterpart to copy.
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.2)" },
  menuPanel: {
    position: "absolute",
    right: 12,
    width: 220,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
    overflow: "hidden",
    ...shadow.md,
  },
  menuIdentity: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  menuIdentityLabel: {
    fontFamily: font.regular,
    fontSize: 10,
    letterSpacing: 0.6,
    color: theme.subtle,
  },
  menuName: { fontSize: 13, fontFamily: font.semibold, color: theme.text, marginTop: 2 },
  menuEmail: { fontFamily: font.regular, fontSize: 11, color: theme.text, marginTop: 2 },
  menuItem: { paddingVertical: 10, paddingHorizontal: 14 },
  menuItemDivided: { borderTopWidth: 1, borderTopColor: theme.border },
  menuItemText: { fontFamily: font.regular, fontSize: 13, color: theme.text },
  menuItemDanger: { color: theme.danger },
});
