import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Card } from "@/components/ui";
import { ApiError, deleteAccount } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";
import {
  DELETE_CONFIRM_PHRASE,
  isDeleteConfirmationValid,
} from "@/shared/lib/accountDeletion";

/**
 * Native mirror of src/components/DeleteAccountSection.tsx.
 *
 * This one is not optional polish: App Store guideline 5.1.1(v) requires an app
 * that can create an account to offer deletion from inside the app itself, and a
 * link out to the website does not satisfy it. The web page having the same
 * feature is the mirror, not the other way round.
 *
 * Same obstruction as the web — type the phrase to arm the destructive button —
 * because deletion is immediate and unrecoverable on both platforms.
 */
export default function DeleteAccountSection() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = isDeleteConfirmationValid(confirmText);
  /**
   * Re-entrancy guard — `deleting` is state and updates a render too late, so a
   * double tap could fire two deletions. The second finds no user row and comes
   * back "Account not found.", stranding the user on Settings with a dead token
   * over an account that was deleted successfully. A ref updates synchronously.
   */
  const inFlight = useRef(false);

  function close() {
    if (deleting) return;
    setOpen(false);
    setConfirmText("");
    setError(null);
  }

  async function confirmDelete() {
    if (!armed || inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);

    try {
      await deleteAccount(confirmText);
    } catch (e) {
      inFlight.current = false;
      setDeleting(false);
      setError(
        e instanceof ApiError ? e.message : "Could not delete your account. Please try again."
      );
      return;
    }

    // Past this point the account is GONE, so nothing below may surface as a
    // failure. The session row cascaded away with the user, so the stored token
    // is already dead — dropping it is housekeeping that stops the auth gate
    // trying it once more and bouncing off a 401.
    await clearToken();
    setOpen(false);
    router.replace("/sign-in");
  }

  return (
    <>
      <Text style={styles.eyebrow}>DANGER ZONE</Text>
      <Card style={styles.section}>
        <Text style={styles.sectionTitle}>Delete account</Text>
        <Text style={styles.sectionBlurb}>
          Permanently deletes your account and everything in it — your trips, routes, stops,
          fuel plans, vehicles and your whole conversation history with Penny. This happens
          immediately and cannot be undone.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={styles.outlineDangerBtn}
        >
          <Text style={styles.outlineDangerText}>Delete account</Text>
        </Pressable>
      </Card>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        // Android hardware back / iOS swipe-to-dismiss must cancel, never confirm.
        onRequestClose={close}
      >
        <View style={styles.backdrop}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Are you sure you want to delete your account?</Text>
            <Text style={styles.dialogBody}>
              Everything goes: trips, routes, stops, fuel plans, vehicles and your chat
              history. This cannot be undone and there is no recovery window.
            </Text>

            <Text style={styles.label}>
              Type <Text style={styles.labelStrong}>{DELETE_CONFIRM_PHRASE}</Text> to confirm
            </Text>
            <TextInput
              value={confirmText}
              onChangeText={setConfirmText}
              editable={!deleting}
              placeholder={DELETE_CONFIRM_PHRASE}
              placeholderTextColor={theme.subtle}
              // iOS would otherwise capitalise the first letter and autocorrect
              // the phrase out from under the user.
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              accessibilityRole="button"
              disabled={!armed || deleting}
              onPress={confirmDelete}
              style={[styles.dangerBtn, (!armed || deleting) && styles.dangerBtnDisabled]}
            >
              <Text
                style={[
                  styles.dangerBtnText,
                  (!armed || deleting) && styles.dangerBtnTextDisabled,
                ]}
              >
                {deleting ? "Deleting…" : "Delete"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={deleting}
              onPress={close}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.danger,
    letterSpacing: 1.6,
    marginTop: 16,
    marginBottom: 4,
  },
  section: {
    padding: 20,
    marginBottom: 16,
    backgroundColor: theme.dangerMuted,
    borderColor: "rgba(198, 93, 74, 0.4)",
  },
  sectionTitle: { fontSize: 17, fontFamily: font.medium, color: theme.text, marginBottom: 6 },
  sectionBlurb: {
    fontFamily: font.regular,
    fontSize: 13,
    color: theme.muted,
    lineHeight: 20,
    marginBottom: 14,
  },
  outlineDangerBtn: {
    alignSelf: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(198, 93, 74, 0.55)",
  },
  outlineDangerText: { fontFamily: font.semibold, fontSize: 13, color: theme.danger },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  dialog: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 24,
  },
  dialogTitle: { fontFamily: font.medium, fontSize: 18, color: theme.text, marginBottom: 10 },
  dialogBody: {
    fontFamily: font.regular,
    fontSize: 13,
    color: theme.muted,
    lineHeight: 20,
    marginBottom: 16,
  },
  label: { fontFamily: font.regular, fontSize: 13, color: theme.text, marginBottom: 6 },
  labelStrong: { fontFamily: font.medium, color: theme.text },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontFamily: font.regular,
    fontSize: 14,
    color: theme.text,
    marginBottom: 16,
  },
  error: { fontFamily: font.regular, fontSize: 12, color: theme.danger, marginBottom: 12 },
  /*
   * The LAST solid fill in the app, and it stays one on both platforms. Every
   * other action is an outline now, which is exactly what lets this read as
   * different in kind rather than merely important.
   */
  dangerBtn: {
    backgroundColor: theme.danger,
    borderWidth: 1,
    borderColor: theme.dangerBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 8,
  },
  dangerBtnDisabled: { backgroundColor: theme.dangerMuted },
  dangerBtnText: { fontFamily: font.semibold, fontSize: 15, color: theme.bg },
  /* The fill drops to a 14% tint when disarmed, so the label has to come with
     it — `theme.bg` on that tint is dark-on-dark and vanishes. */
  dangerBtnTextDisabled: { color: theme.danger },
  cancelBtn: { paddingVertical: 12, alignItems: "center" },
  cancelText: { fontFamily: font.regular, fontSize: 14, color: theme.muted },
});
