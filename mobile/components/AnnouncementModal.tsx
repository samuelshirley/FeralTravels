import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { activeAnnouncement, dismissAnnouncement } from "@/lib/api";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/components/AnnouncementModal.tsx.
 *
 * One-time announcement popup. Fetches the newest undismissed active
 * announcement on mount. Once the user taps the CTA button, we POST a
 * dismissal and the modal never shows again for that user + announcement.
 */
interface Announcement {
  id: string;
  title: string;
  body: string;
  /**
   * The server always sends this; typed optional because lib/api's
   * Announcement interface does not declare it and we may not edit that file.
   */
  buttonText?: string;
}

/**
 * `/api/announcements/active` answers `{ announcement }` (that is what the web
 * client reads), while lib/api types the call as the bare row. Accept either
 * shape here rather than editing the shared client.
 */
function unwrap(raw: unknown): Announcement | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const candidate = ("announcement" in rec ? rec.announcement : rec) as Record<
    string,
    unknown
  > | null;
  if (!candidate || typeof candidate !== "object") return null;
  if (typeof candidate.id !== "string") return null;
  return {
    id: candidate.id,
    title: typeof candidate.title === "string" ? candidate.title : "",
    body: typeof candidate.body === "string" ? candidate.body : "",
    buttonText: typeof candidate.buttonText === "string" ? candidate.buttonText : undefined,
  };
}

export default function AnnouncementModal() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw: unknown = await activeAnnouncement();
        if (!cancelled) setAnnouncement(unwrap(raw));
      } catch {
        // Best-effort, same as web — an announcement is never worth an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDismiss() {
    if (!announcement || dismissing) return;
    setDismissing(true);
    try {
      await dismissAnnouncement(announcement.id);
    } catch {
      // Best-effort — if it fails, they'll see it again next visit.
    }
    setAnnouncement(null);
    setDismissing(false);
  }

  if (!announcement) return null;

  return (
    // The web fades the overlay in after a frame so the page behind registers
    // first; Modal's own fade animation is the native equivalent.
    <Modal visible transparent animationType="fade" onRequestClose={handleDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {/* The web accent bar is a primary→warm gradient. No gradient
              dependency in this app, so approximate it with two halves. */}
          <View style={styles.accentBar}>
            <View style={[styles.accentHalf, { backgroundColor: theme.primary }]} />
            <View style={[styles.accentHalf, { backgroundColor: theme.accentWarm }]} />
          </View>

          <View style={styles.body}>
            <Text style={styles.title}>{announcement.title}</Text>
            {/* Announcement bodies can be long; keep the CTA reachable. */}
            <ScrollView style={styles.bodyScroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.bodyText}>{announcement.body}</Text>
            </ScrollView>

            <Pressable
              accessibilityRole="button"
              disabled={dismissing}
              onPress={handleDismiss}
              style={[styles.cta, dismissing && styles.ctaDismissing]}
            >
              <Text style={styles.ctaText}>{announcement.buttonText ?? "Got it"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // src/components/AnnouncementModal.tsx:66 — hard-coded on the web too.
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusMd,
    overflow: "hidden",
    ...shadow.md,
  },
  accentBar: { height: 4, flexDirection: "row" },
  accentHalf: { flex: 1 },
  body: { paddingTop: 28, paddingHorizontal: 24, paddingBottom: 24 },
  title: { fontSize: 20, fontFamily: font.bold, color: theme.text, marginBottom: 12, lineHeight: 26 },
  bodyScroll: { maxHeight: 320, marginBottom: 24 },
  bodyText: { fontFamily: font.regular, fontSize: 14, lineHeight: 22, color: theme.muted },
  cta: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primary,
    alignItems: "center",
  },
  ctaDismissing: { backgroundColor: theme.muted },
  ctaText: { fontSize: 14, fontFamily: font.semibold, color: theme.onPrimary },
});
