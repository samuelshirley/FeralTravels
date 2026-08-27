import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Card } from "@/components/ui";
import { deleteTrip, isAuthError } from "@/lib/api";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/app/trips/TripCard.tsx. Same props, same copy, same
 * two visual modes (own trip vs. DEMO / TEMPLATES accent) — the web card is
 * the spec, this just swaps <Link> for a Pressable that routes.
 */
interface Props {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  /** When true, render the trip card in the "DEMO / TEMPLATES" accent. */
  isTemplate?: boolean;
  /**
   * The trip's last day is behind the user — the card says so and goes quiet.
   * Derived by the list (lib/tripCompletion) so "today" is resolved once, in
   * the device's timezone.
   */
  completed?: boolean;
  /**
   * When true, the card reveals a persistent × delete button in the corner.
   * Driven by the parent's Edit-trips toggle.
   */
  editMode?: boolean;
  /**
   * When set, renders a "Clone to my trips" action next to "View". Only
   * meaningful for template cards where the user hasn't started editing
   * their own copy yet.
   */
  showClone?: boolean;
  onCloneClick?: (id: string) => void;
  cloneBusy?: boolean;
  /** Called after a successful delete so the parent can remove this card immediately. */
  onDeleted?: (id: string) => void;
}

export default function TripCard({
  id,
  name,
  startDate,
  endDate,
  isTemplate = false,
  completed = false,
  editMode = false,
  showClone = false,
  onCloneClick,
  cloneBusy = false,
  onDeleted,
}: Props) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  // Same expression as the web card so a half-dated trip renders identically.
  const dates = [startDate, endDate].filter(Boolean).join(" → ") || "No dates set";

  async function handleDeleteConfirm() {
    setBusy(true);
    try {
      await deleteTrip(id);
      setShowConfirm(false);
      // Optimistic: hand the id up so the list drops the row without waiting
      // for a refetch (the web does the same via onDeleted + router.refresh).
      onDeleted?.(id);
    } catch (err) {
      setBusy(false);
      setShowConfirm(false);
      if (isAuthError(err)) router.replace("/sign-in");
      // Other API errors surface via the global error notifier, same as web.
    }
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        // In edit mode the web Link preventDefaults — the card is a delete
        // target, not a nav target.
        disabled={editMode}
        onPress={() => router.push(`/trips/${id}`)}
      >
        {/* Template accent wins over the edit-mode border, exactly as on web. */}
        <Card
          style={
            isTemplate
              ? styles.cardTemplate
              : editMode
                ? styles.cardEditing
                : completed
                  ? styles.cardCompleted
                  : undefined
          }
        >
          <Text
            style={[styles.name, { paddingRight: editMode ? 40 : completed ? 96 : 28 }]}
          >
            {name}
          </Text>
          <Text style={styles.dates}>{dates}</Text>

          {showClone && !editMode ? (
            <View style={styles.actions}>
              {/* Affordance only — the whole card is already the "View" target. */}
              <View style={styles.viewPill}>
                <Text style={styles.viewPillText}>View →</Text>
              </View>
              <Pressable
                disabled={cloneBusy}
                onPress={() => onCloneClick?.(id)}
                style={[styles.clonePill, cloneBusy && styles.clonePillBusy]}
              >
                {cloneBusy ? <ActivityIndicator size="small" color={theme.success} /> : null}
                <Text style={styles.clonePillText}>
                  {cloneBusy ? "Cloning…" : "Clone to my trips"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Card>
      </Pressable>

      {/* Outside the Card so the card's dimming doesn't reach the badge, and
          skipped in edit mode where the × owns that corner — same as web. */}
      {completed && !editMode ? (
        <View style={styles.completedBadge}>
          <Text style={styles.completedBadgeText}>COMPLETED</Text>
        </View>
      ) : null}

      {editMode ? (
        <Pressable
          accessibilityLabel="Delete trip"
          accessibilityRole="button"
          onPress={() => setShowConfirm(true)}
          style={styles.deleteCorner}
          // Enlarge the touch target without growing the 28pt circle.
          hitSlop={8}
        >
          <Text style={styles.deleteCornerText}>×</Text>
        </Pressable>
      ) : null}

      <Modal
        visible={showConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setShowConfirm(false);
        }}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => {
            if (!busy) setShowConfirm(false);
          }}
        >
          {/* Swallow taps on the sheet so the backdrop press doesn't close it. */}
          <Pressable style={styles.confirmSheet} onPress={() => {}}>
            <Text style={styles.confirmTitle}>Delete trip?</Text>
            <Text style={styles.confirmBody}>
              {`“${name}” will be permanently deleted.`}
            </Text>
            <View style={styles.confirmActions}>
              <Pressable
                disabled={busy}
                onPress={() => setShowConfirm(false)}
                style={styles.cancelBtn}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={handleDeleteConfirm}
                style={[styles.deleteBtn, busy && styles.deleteBtnBusy]}
              >
                {busy ? <ActivityIndicator size="small" color={theme.onPrimary} /> : null}
                <Text style={styles.deleteBtnText}>{busy ? "Deleting…" : "Delete"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  // src/app/layout.tsx:181 — .card-grid { gap: 10px } ≤767px.
  wrap: { position: "relative", marginBottom: 10 },
  cardTemplate: {
    backgroundColor: theme.primaryMuted,
    // src/app/trips/TripCard.tsx:85
    borderColor: "rgba(78, 122, 176, 0.28)",
  },
  // src/app/trips/TripCard.tsx:87
  cardEditing: { borderColor: "rgba(201, 123, 99, 0.45)" },
  // Same dimming the itinerary's "behind you" section uses, so a finished trip
  // reads as past wherever it appears.
  cardCompleted: { backgroundColor: theme.surfaceMuted, opacity: 0.75 },
  completedBadge: {
    position: "absolute",
    top: 12,
    right: 12,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  completedBadgeText: {
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1,
    color: theme.muted,
  },
  name: { fontSize: 16, fontFamily: font.semibold, color: theme.text },
  dates: { fontFamily: font.regular, fontSize: 12, color: theme.muted, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  viewPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.primaryMuted,
    backgroundColor: theme.surfaceMuted,
  },
  viewPillText: { fontFamily: font.regular, fontSize: 12, color: theme.primary },
  clonePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    // src/app/trips/TripCard.tsx:140
    borderColor: "rgba(74, 139, 122, 0.35)",
    backgroundColor: theme.successMuted,
  },
  clonePillBusy: { opacity: 0.7 },
  clonePillText: { fontFamily: font.regular, fontSize: 12, color: theme.success },
  deleteCorner: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    // src/app/trips/TripCard.tsx:175
    borderColor: "rgba(198, 93, 74, 0.5)",
    alignItems: "center",
    justifyContent: "center",
    ...shadow.md,
  },
  deleteCornerText: { fontFamily: font.regular, fontSize: 18, lineHeight: 20, color: theme.danger },
  backdrop: {
    flex: 1,
    // src/app/trips/TripCard.tsx:197 — background: var(--tp-overlay)
    backgroundColor: theme.overlay,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  confirmSheet: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusMd,
    padding: 24,
    ...shadow.md,
  },
  confirmTitle: { fontSize: 16, fontFamily: font.semibold, color: theme.text, marginBottom: 8 },
  confirmBody: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: theme.muted, marginBottom: 24 },
  confirmActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.border,
  },
  cancelBtnText: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.danger,
  },
  deleteBtnBusy: { opacity: 0.7 },
  deleteBtnText: { fontSize: 13, fontFamily: font.semibold, color: theme.onPrimary },
});
