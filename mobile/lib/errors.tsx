import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError, registerGlobalErrorReporter } from "@/lib/api";
import { pickSillyError } from "@/shared/lib/sillyErrors";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/components/ErrorNotifier.tsx.
 *
 * One global error surface, registered with apiFetch so every call that does
 * not opt out lands here. 4xx → auto-dismissing toast. 5xx / network → a
 * full-screen "silly error" sheet carrying the server's errorId so a user can
 * read a correlation ID out loud.
 */
interface ErrorApi {
  /** Show a toast without going through an API call (inline validation etc). */
  notify: (message: string) => void;
}
const Ctx = createContext<ErrorApi>({ notify: () => {} });
export const useErrors = () => useContext(Ctx);

interface Fatal {
  headline: string;
  emoji: string;
  /** The silly-error body copy, plus the real server message underneath. */
  blurb: string;
  message: string;
  errorId: string | null;
}

export function ErrorProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback(
    (message: string) => {
      setToast(message);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
          () => setToast(null)
        );
      }, 5000);
    },
    [opacity]
  );

  useEffect(() => {
    registerGlobalErrorReporter((err, ctx) => {
      // 401 is not an error the user needs to read — the gate routes them to
      // sign-in. Anything else 4xx is actionable copy; 5xx/network is a fault.
      if (ctx.status === 401) return;
      const message = err instanceof ApiError ? err.message : "Something went wrong.";
      if (ctx.status != null && ctx.status >= 400 && ctx.status < 500) {
        notify(message);
        return;
      }
      const silly = pickSillyError();
      setFatal({
        headline: silly.headline,
        emoji: silly.emoji,
        blurb: silly.body,
        message,
        errorId: err instanceof ApiError ? err.errorId : null,
      });
    });
    return () => registerGlobalErrorReporter(null);
  }, [notify]);

  return (
    <Ctx.Provider value={{ notify }}>
      {children}

      {toast ? (
        <Animated.View style={[styles.toast, { opacity }]} pointerEvents="box-none">
          <Pressable onPress={() => setToast(null)} style={styles.toastInner}>
            <Text style={styles.toastText}>{toast}</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      <Modal visible={fatal != null} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <Text style={styles.fatalEmoji}>{fatal?.emoji}</Text>
            <Text style={styles.fatalTitle}>{fatal?.headline}</Text>
            <Text style={styles.fatalBody}>{fatal?.blurb}</Text>
            <Text style={styles.fatalDetail}>{fatal?.message}</Text>
            {fatal?.errorId ? <Text style={styles.errorId}>{fatal.errorId}</Text> : null}
            <Pressable style={styles.fatalButton} onPress={() => setFatal(null)}>
              <Text style={styles.fatalButtonText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  toast: { position: "absolute", left: 16, right: 16, bottom: 96 },
  toastInner: {
    backgroundColor: theme.dangerMuted,
    // The web toast (src/components/ErrorNotifier.tsx:149) is a solid
    // rgba(198, 93, 74, 0.95); this is the standard danger border literal,
    // e.g. src/app/login/page.tsx:111.
    borderColor: "rgba(198, 93, 74, 0.35)",
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    padding: 12,
    ...shadow.md,
  },
  toastText: { fontFamily: font.regular, color: theme.danger, fontSize: 13, lineHeight: 18 },
  backdrop: {
    flex: 1,
    // src/components/ErrorNotifier.tsx:245 — background: var(--tp-overlay)
    backgroundColor: theme.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusMd,
    padding: 24,
    ...shadow.md,
  },
  fatalEmoji: { fontFamily: font.regular, fontSize: 40, textAlign: "center", marginBottom: 8 },
  fatalDetail: { fontFamily: font.regular, fontSize: 12, lineHeight: 17, color: theme.subtle, marginBottom: 8 },
  fatalTitle: { fontSize: 20, fontFamily: font.bold, color: theme.text, marginBottom: 10 },
  fatalBody: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: theme.muted, marginBottom: 12 },
  errorId: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    marginBottom: 16,
    fontVariant: ["tabular-nums"],
  },
  fatalButton: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
  },
  fatalButtonText: { color: theme.onPrimary, fontFamily: font.semibold, fontSize: 14 },
});
