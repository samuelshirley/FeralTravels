import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearToken } from "@/lib/auth";
import { getMe, listVehicles, type Me, type Vehicle } from "@/lib/api";
import { useSignedInEmail, initialsFor } from "@/lib/identity";
import SupportModal from "@/components/SupportModal";
import { theme, shadow } from "@/lib/theme";
import { ChevronLeftIcon, TruckIcon } from "@/components/icons";
import { font } from "@/lib/typography";

/**
 * Native mirror of the trip-context AppNavbar (src/components/AppNavbar.tsx),
 * with TripVehicleChip and the fuel-syncing indicator folded in — on a phone
 * they are always rendered together, so one component beats three.
 */
interface Props {
  tripName?: string;
  /** Trip's assigned vehicle; the chip renders nothing until one exists. */
  vehicleId?: string | null;
  /** A leg's day-open fuel search is in flight. */
  fuelBusy?: boolean;
  /** Read-only (template) trips hide the vehicle/fuel chips, as on the web. */
  readonly?: boolean;
}

/**
 * Vehicle list cache — mirrors src/lib/vehicleCache.ts. The chip mounts on
 * every workspace open and the list almost never changes, so one fetch per app
 * launch is enough.
 */
let vehiclesPromise: Promise<Vehicle[]> | null = null;
function fetchVehicles(): Promise<Vehicle[]> {
  if (!vehiclesPromise) {
    vehiclesPromise = listVehicles().catch(() => []);
  }
  return vehiclesPromise;
}

export default function TripHeader({
  tripName,
  vehicleId = null,
  fuelBusy = false,
  readonly = false,
}: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch(() => {
        // The menu still works without a name/email header.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signedInEmail = useSignedInEmail();
  const initials = initialsFor(signedInEmail);

  const go = useCallback(
    (path: "/trips" | "/settings") => {
      setMenuOpen(false);
      router.push(path);
    },
    [router]
  );

  async function signOut() {
    setMenuOpen(false);
    await clearToken();
    router.replace("/sign-in");
  }

  return (
    <View style={[styles.bar, { paddingTop: insets.top + 10 }]}>
      <View style={styles.left}>
        {/* Inside a trip the brand slot is a one-tap way back to the trip list. */}
        <Pressable
          onPress={() => router.push("/trips")}
          accessibilityRole="button"
          accessibilityLabel="Back to trips"
          hitSlop={8}
          style={styles.backLink}
        >
          <ChevronLeftIcon color={theme.text} />
          <Text style={styles.backLabel}>Trips</Text>
        </Pressable>
        {tripName ? (
          <>
            <Text style={styles.sep}>/</Text>
            <Text style={styles.tripName} numberOfLines={1} ellipsizeMode="tail">
              {tripName}
            </Text>
          </>
        ) : null}
      </View>

      <View style={styles.right}>
        {!readonly && fuelBusy ? (
          // Quiet "why is this taking a moment" signal while a day's fuel search
          // runs. The web drops the label at phone widths to save header space;
          // native has no browser chrome competing for it, so we keep it.
          <View
            style={styles.fuelChip}
            accessibilityLabel="Refreshing fuel stops along your route"
          >
            <ActivityIndicator size="small" color={theme.gold} />
            <Text style={styles.fuelText}>Fuel…</Text>
          </View>
        ) : null}
        {!readonly ? <VehicleChip vehicleId={vehicleId} /> : null}
        <Pressable
          onPress={() => setMenuOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Account menu"
          style={styles.accountBtn}
        >
          <Text style={styles.accountInitials}>{initials}</Text>
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        {/* Tap-anywhere-to-dismiss stands in for the web's outside-mousedown handler. */}
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menu, { top: insets.top + 48 }]}>
            <View style={styles.menuIdentity}>
              {signedInEmail ? (
                <Text style={styles.menuEmail} numberOfLines={1}>
                  {signedInEmail}
                </Text>
              ) : null}
            </View>
            <Pressable style={styles.menuItem} onPress={() => go("/trips")}>
              <Text style={styles.menuItemText}>Trips</Text>
            </Pressable>
            <Pressable style={[styles.menuItem, styles.menuDivider]} onPress={() => go("/settings")}>
              <Text style={styles.menuItemText}>Settings</Text>
            </Pressable>
            <Pressable
              style={[styles.menuItem, styles.menuDivider]}
              onPress={() => {
                setMenuOpen(false);
                setSupportOpen(true);
              }}
            >
              <Text style={styles.menuItemText}>Contact Support</Text>
            </Pressable>
            <Pressable style={[styles.menuItem, styles.menuDivider]} onPress={signOut}>
              <Text style={[styles.menuItemText, styles.menuItemDanger]}>Sign out</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />
    </View>
  );
}

/**
 * Display-only chip showing the trip's vehicle name — mirrors
 * src/components/TripVehicleChip.tsx. No picker: the vehicle is chosen during
 * onboarding or changed in Settings. Renders nothing until one is assigned.
 */
function VehicleChip({ vehicleId }: { vehicleId: string | null }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVehicles().then((list) => {
      if (!cancelled) setVehicles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = vehicles?.find((v) => v.id === vehicleId) ?? null;
  if (!current) return null;

  return (
    <View style={styles.vehicleChip} accessibilityLabel={`Trip vehicle: ${current.name}`}>
      {/* src/components/TripVehicleChip.tsx:48-50 — same path, same 0.55 opacity. */}
      <TruckIcon color={theme.text} />
      <Text style={styles.vehicleText} numberOfLines={1}>
        {current.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // src/components/AppNavbar.tsx:47 — padding: '10px 16px'
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
    backgroundColor: theme.surfaceMuted,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    ...shadow.sm,
  },
  // gap 12 / 10 mirror src/components/AppNavbar.tsx:60 and :124.
  left: { flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 1, minWidth: 0 },
  right: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 0 },
  backLink: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, fontFamily: font.bold, color: theme.text },
  sep: { fontFamily: font.regular, color: theme.subtle, fontSize: 14 },
  tripName: { flexShrink: 1, fontSize: 14, fontFamily: font.semibold, color: theme.muted },

  fuelChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  fuelText: { fontFamily: font.regular, fontSize: 11, color: theme.muted },

  vehicleChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 140,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 14,
  },
  vehicleText: { fontFamily: font.regular, fontSize: 12, letterSpacing: 0.24, color: theme.text, flexShrink: 1 },
  accountBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: theme.surface,
    // src/components/AppNavbar.tsx:163 — deliberate opaque literal, not a token.
    backgroundColor: "#DFE5ED",
    alignItems: "center",
    justifyContent: "center",
    ...shadow.sm,
  },
  // src/components/AppNavbar.tsx:164 — deliberate opaque literal, not a token.
  accountInitials: { color: "#4E7AB0", fontSize: 12, fontFamily: font.extrabold },

  // Native-only: src/components/AppNavbar.tsx closes the menu on outside
  // mousedown with no visible scrim, so there is no web value to copy.
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.15)" },
  menu: {
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
  menuIdentity: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
  menuName: { fontSize: 13, fontFamily: font.semibold, color: theme.text },
  menuEmail: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, marginTop: 2 },
  menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  menuDivider: { borderTopWidth: 1, borderTopColor: theme.border },
  menuItemText: { fontFamily: font.regular, fontSize: 13, color: theme.text },
  menuItemDanger: { color: theme.danger },

});
