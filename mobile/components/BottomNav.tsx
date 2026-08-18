import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme, shadow } from "@/lib/theme";
import { ChatIcon, ListIcon, MapIcon, SettingsIcon } from "@/components/icons";
import { font } from "@/lib/typography";

/** Native mirror of src/components/BottomNav.tsx. */
export type MobileTab = "list" | "map" | "chat";

interface BottomNavProps {
  /**
   * Which tab is currently highlighted. `'settings'` highlights the gear;
   * `undefined` leaves no item highlighted (used on screens that aren't
   * reachable via any of the four nav items).
   */
  active?: MobileTab | "settings";
  /**
   * Tab change handler. Optional because the nav can be mounted on screens
   * with no trip context (e.g. /settings, /trips). When absent, list/map/chat
   * navigate to /trips instead of toggling a parent's state.
   */
  onChange?: (tab: MobileTab) => void;
  thinking?: boolean;
  unread?: number;
}

interface NavItem {
  id: MobileTab | "settings";
  label: string;
  badge?: "thinking" | number;
}

export default function BottomNav({
  active,
  onChange,
  thinking = false,
  unread = 0,
}: BottomNavProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const items: NavItem[] = [
    { id: "list", label: "List" },
    { id: "map", label: "Map" },
    {
      id: "chat",
      label: "Chat",
      badge: thinking ? "thinking" : unread > 0 ? unread : undefined,
    },
    { id: "settings", label: "Settings" },
  ];

  function handlePress(id: MobileTab | "settings") {
    // Settings is a route, never a pane — it leaves the workspace entirely.
    if (id === "settings") {
      router.push("/settings");
      return;
    }
    // Without a trip context the three trip tabs can't toggle anything, so
    // they route to the trips list as the hub (matches the web).
    if (!onChange) {
      router.push("/trips");
      return;
    }
    onChange(id);
  }

  return (
    <View style={[styles.nav, { paddingBottom: insets.bottom }]}>
      <View style={styles.row}>
        {items.map((item) => {
          const isActive = item.id === active;
          const color = isActive ? theme.primary : theme.muted;
          return (
            <Pressable
              key={item.id}
              onPress={() => handlePress(item.id)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: isActive }}
              style={styles.item}
            >
              <View style={styles.glyphSlot}>
                <NavGlyph id={item.id} color={color} />
                {item.badge === "thinking" ? <ThinkingDot /> : null}
                {typeof item.badge === "number" && item.badge > 0 ? (
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>
                      {item.badge > 9 ? "9+" : String(item.badge)}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.label, { color }, isActive && styles.labelActive]}>
                {item.label.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The four nav icons, straight from src/components/BottomNav.tsx's `iconPath`
 * table. `color` stands in for the web's `currentColor`.
 */
function NavGlyph({ id, color }: { id: MobileTab | "settings"; color: string }) {
  if (id === "list") return <ListIcon color={color} />;
  if (id === "map") return <MapIcon color={color} />;
  if (id === "chat") return <ChatIcon color={color} />;
  return <SettingsIcon color={color} />;
}

/** The web's `tp-pulse` keyframes: 0.5→1 opacity, 0.9→1.15 scale, 1.2s loop. */
function ThinkingDot() {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [t]);

  return (
    <Animated.View
      accessibilityLabel="Penny is thinking"
      style={[
        styles.thinkingDot,
        {
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
          transform: [
            { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] }) },
          ],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  nav: {
    backgroundColor: theme.surfaceMuted,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    ...shadow.sm,
  },
  row: { flexDirection: "row" },
  // Four equal columns — the web's `grid-template-columns: repeat(4, 1fr)`.
  item: {
    flex: 1,
    alignItems: "center",
    gap: 3,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  glyphSlot: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  thinkingDot: {
    position: "absolute",
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.success,
  },
  countBadge: {
    position: "absolute",
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: theme.accentWarm,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadgeText: {
    color: theme.onPrimary,
    fontSize: 10,
    fontFamily: font.bold,
    lineHeight: 12,
  },
  label: { fontSize: 10, letterSpacing: 0.5, fontFamily: font.medium },
  labelActive: { fontFamily: font.bold },
});
