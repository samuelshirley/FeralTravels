import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { isAuthError, sendSupport } from "@/lib/api";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/components/SupportModal.tsx — same header, same
 * "How can we help?" form, same "Message sent" confirmation state.
 */
interface SupportModalProps {
  open: boolean;
  onClose: () => void;
}

type Status = "idle" | "sending" | "sent" | "error" | "unavailable";

export default function SupportModal({ open, onClose }: SupportModalProps) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  function handleClose() {
    if (status === "sending") return;
    setMessage("");
    setStatus("idle");
    onClose();
  }

  async function handleSubmit() {
    if (!message.trim() || status === "sending") return;
    setStatus("sending");
    try {
      await sendSupport(message.trim());
      setStatus("sent");
    } catch (err) {
      // /api/support authenticates with `auth()`, which only reads the web
      // session cookie — our bearer token is rejected with a 401. Say so
      // plainly instead of showing the generic retry copy, which would send
      // the user in circles.
      // TODO(sam): switch the route to `requireUserId()` (it accepts the
      // mobile bearer token as well as the cookie) so this works from the app.
      setStatus(isAuthError(err) ? "unavailable" : "error");
    }
  }

  const canSend = Boolean(message.trim()) && status !== "sending";

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      // The web closes on backdrop click / Escape; onRequestClose is the
      // Android back-button equivalent.
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.backdrop} onPress={handleClose}>
          {/* Swallow taps inside the sheet so they don't dismiss the modal. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.header}>
              <Text style={styles.headerTitle}>Contact Support</Text>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                onPress={handleClose}
                hitSlop={10}
              >
                <Text style={styles.closeX}>×</Text>
              </Pressable>
            </View>

            <View style={styles.body}>
              {status === "sent" ? (
                <View style={styles.sentWrap}>
                  <Text style={styles.sentTitle}>Message sent</Text>
                  <Text style={styles.sentBody}>We&apos;ll get back to you as soon as we can.</Text>
                  <Pressable onPress={handleClose} style={styles.sentClose}>
                    <Text style={styles.sentCloseText}>Close</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <Text style={styles.label}>How can we help?</Text>
                  <TextInput
                    value={message}
                    onChangeText={(next) => {
                      setMessage(next);
                      // Clear a previous failure as soon as they start editing.
                      if (status === "error") setStatus("idle");
                    }}
                    placeholder="Describe the issue you're experiencing..."
                    placeholderTextColor={theme.subtle}
                    multiline
                    numberOfLines={5}
                    maxLength={5000}
                    autoFocus
                    editable={status !== "sending"}
                    textAlignVertical="top"
                    style={styles.textarea}
                  />
                  {status === "error" ? (
                    <Text style={styles.errorText}>Something went wrong. Please try again.</Text>
                  ) : null}
                  {status === "unavailable" ? (
                    <Text style={styles.errorText}>
                      Support messages aren&apos;t available in the app yet.
                    </Text>
                  ) : null}
                  <View style={styles.actions}>
                    <Pressable onPress={handleClose} style={styles.cancelBtn}>
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      disabled={!canSend}
                      onPress={handleSubmit}
                      style={[
                        styles.sendBtn,
                        status === "sending" && styles.sendBtnSending,
                        !message.trim() && styles.sendBtnEmpty,
                      ]}
                    >
                      <Text style={styles.sendBtnText}>
                        {status === "sending" ? "Sending..." : "Send"}
                      </Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    // src/components/SupportModal.tsx:77 — hard-coded on the web too.
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  sheet: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    overflow: "hidden",
    ...shadow.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  headerTitle: { fontSize: 15, fontFamily: font.semibold, color: theme.text },
  closeX: { fontFamily: font.regular, fontSize: 18, lineHeight: 20, color: theme.subtle, padding: 4 },
  body: { paddingVertical: 16, paddingHorizontal: 18 },
  label: { fontSize: 13, fontFamily: font.medium, color: theme.muted, marginBottom: 6 },
  textarea: {
    fontFamily: font.regular,
    minHeight: 110,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    lineHeight: 21,
    color: theme.text,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
  },
  errorText: { fontFamily: font.regular, fontSize: 12, color: theme.danger, marginTop: 8 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 14 },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  cancelBtnText: { fontSize: 13, fontFamily: font.medium, color: theme.text },
  sendBtn: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primary,
  },
  sendBtnSending: { backgroundColor: theme.muted },
  sendBtnEmpty: { opacity: 0.5 },
  sendBtnText: { fontSize: 13, fontFamily: font.semibold, color: theme.onPrimary },
  sentWrap: { alignItems: "center", paddingVertical: 20 },
  sentTitle: { fontSize: 14, fontFamily: font.semibold, color: theme.text, marginBottom: 6 },
  sentBody: { fontFamily: font.regular, fontSize: 13, color: theme.muted, textAlign: "center" },
  sentClose: {
    marginTop: 18,
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  sentCloseText: { fontSize: 13, fontFamily: font.semibold, color: theme.text },
});
