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
import AccountButton from "@/components/AccountButton";
import { useIdentity } from "@/lib/identity";
import { theme, shadow } from "@/lib/theme";
import type { Trip } from "@/shared/types/trip";
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
 * See `styles.headerAccount`: 14pt page gutter − 16pt UIKit nav-bar margin.
 * If the button still doesn't line up on a given device, this is the one knob.
 */
const HEADER_ACCOUNT_EDGE_NUDGE = -2;

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
      const [tripsRes, meRes] = await Promise.all([listTrips(), getMe() as Promise<MeWithId>]);
      setTrips(tripsRes);
      setMe(meRes);
      setMeId(meRes.id ?? null);
    } catch (err) {
      if (!handleAuthError(err)) {
        // Non-auth failures already surfaced through the global error notifier.
        setTrips((prev) => prev ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [handleAuthError]);

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
    await clearToken();
    router.replace("/sign-in");
  }

  const identity = useIdentity();
  const displayName = identity.name;
  const displayEmail = identity.email;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <AccountButton
              email={displayEmail}
              image={identity.image}
              onPress={() => setMenuOpen(true)}
              style={styles.headerAccount}
            />
          ),
        }}
      />

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
   * The account button hangs off the NATIVE navigation bar (`headerRight`),
   * so UIKit — not this stylesheet — decides how far it sits from the screen
   * edge: the standard iPhone nav-bar layout margin is 16pt. Everything below
   * it on this screen lives inside `listContent`, whose gutter is 14pt
   * (mirroring the web's `.page-main` padding). The button therefore lands 2pt
   * further left than the "+ New trip" button and the trip cards it sits
   * above, which is exactly the misalignment that reads as "not centred".
   *
   * Pull it back over those 2pt rather than widening the page gutter to 16 —
   * the gutter is a mirrored web token and should keep matching the web.
   */
  headerAccount: { marginRight: HEADER_ACCOUNT_EDGE_NUDGE },
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
