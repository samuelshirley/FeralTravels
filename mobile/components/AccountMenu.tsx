import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { theme, shadow } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * The account menu, opened from the avatar on the trips list AND in the trip
 * header. One component for both since 2026-11-02 (Feature requests): there
 * used to be two hand-kept copies, so every new row had to be added twice and
 * the two had already drifted (different backdrop tints, one with a name line).
 *
 * `testIDPrefix` keeps each screen's existing ids — `account-menu-*` on the
 * trips list, `trip-menu-*` in a trip — because the Maestro flows address them
 * by those names.
 *
 * Admin is deliberately NOT here: the /admin guards reject bearer tokens, so
 * the link would only ever 401 from the app.
 */
export interface AccountMenuProps {
  open: boolean;
  /** Distance from the top of the screen to the panel (under the avatar). */
  top: number;
  name?: string | null;
  email: string | null;
  testIDPrefix: "account-menu" | "trip-menu";
  onClose: () => void;
  onTrips: () => void;
  onSettings: () => void;
  onFeatureRequests: () => void;
  onSupport: () => void;
  onSignOut: () => void;
}

export default function AccountMenu({
  open,
  top,
  name,
  email,
  testIDPrefix,
  onClose,
  onTrips,
  onSettings,
  onFeatureRequests,
  onSupport,
  onSignOut,
}: AccountMenuProps) {
  /*
   * The testIDs are load-bearing for the Maestro flows.
   *
   * Each item is a bare `<Text>` inside a `Pressable`, so the `testID` (and
   * `accessibilityRole`) is what publishes it as its own element.
   */
  const items: Array<{ id: string; label: string; onPress: () => void; danger?: boolean }> = [
    { id: "trips", label: "Trips", onPress: onTrips },
    { id: "settings", label: "Settings", onPress: onSettings },
    { id: "feature-requests", label: "Feature requests", onPress: onFeatureRequests },
    { id: "support", label: "Contact Support", onPress: onSupport },
    { id: "signout", label: "Sign out", onPress: onSignOut, danger: true },
  ];

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      {/*
        `accessible={false}` on BOTH wrappers. A Pressable is an accessibility
        element and iOS merges its whole subtree into one node, so without it
        this menu published a single element ("SIGNED IN AS, …, Trips,
        Settings, …") and none of the items existed for VoiceOver or Maestro
        (modalMergeGuard.test.ts). Touch handling is unaffected.
      */}
      <Pressable style={styles.menuBackdrop} onPress={onClose} accessible={false}>
        {/* Swallow taps inside the panel so they don't dismiss the menu. */}
        <Pressable style={[styles.menuPanel, { top }]} onPress={() => {}} accessible={false}>
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
          {items.map((item, i) => (
            <Pressable
              key={item.id}
              style={[styles.menuItem, i > 0 && styles.menuItemDivided]}
              onPress={item.onPress}
              testID={`${testIDPrefix}-${item.id}`}
              accessibilityRole="button"
            >
              <Text style={[styles.menuItemText, item.danger && styles.menuItemDanger]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
