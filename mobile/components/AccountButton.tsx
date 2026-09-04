import { useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { AccountIcon } from "@/components/icons";
import { theme, shadow } from "@/lib/theme";

/**
 * The account avatar, shared by the trips list header and TripHeader.
 *
 * It used to be two copies of "a circle with the user's initials in it", one
 * per screen. Both are gone (2026-08-20). What renders now, in order:
 *
 *  1. The Google profile photo, when the account has one. This is what the
 *     web has always shown and the phone never could — the app holds a bearer
 *     token rather than a server-rendered session, so it had no way to learn
 *     the URL until `GET /api/me/identity`.
 *  2. Otherwise a generic person glyph. That covers emailed-code sign-ins and
 *     every Apple sign-in, since the Apple ID token has no `picture` claim.
 *
 * Never initials. Beyond being identity on screen for no product value, a
 * `<Text>` centred in a `<View>` centres on the FONT's line box rather than
 * the glyph, so Onest ExtraBold sat visibly high in a 32pt circle — part of
 * what read as "not centred" on the phone. An SVG on a 24-unit viewBox and a
 * square image both centre by geometry.
 */

/** Matches src/components/AppNavbar.tsx's 32px button. */
const SIZE = 32;
/** Inset by the 2pt border so the photo sits inside the ring, not under it. */
const PHOTO_SIZE = SIZE - 4;

interface Props {
  onPress: () => void;
  /**
   * The signed-in address. Used for the accessibility label — VoiceOver
   * reading "Account menu, signed in as sam@…" is the screen-reader
   * equivalent of the web's hover card.
   */
  email?: string | null;
  /** Google profile photo URL, or null for the glyph. */
  image?: string | null;
  style?: StyleProp<ViewStyle>;
}

export default function AccountButton({ onPress, email, image, style }: Props) {
  /**
   * A Google avatar URL rots when the user changes their photo, and the
   * stored one is only refreshed at their next sign-in. Without this, RN
   * would leave an empty box; with it, the glyph comes back.
   */
  const [broken, setBroken] = useState(false);
  const photo = image && !broken ? image : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={email ? `Account menu — signed in as ${email}` : "Account menu"}
      // The circle is only 32pt; without this the tap target is under the 44pt
      // minimum on both screens.
      hitSlop={8}
      style={[styles.button, style]}
    >
      <View style={styles.inner} pointerEvents="none">
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={styles.photo}
            onError={() => setBroken(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <AccountIcon color={theme.muted} size={18} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    // Opaque, not the 14%-opacity primary tint, which washes out under iOS's
    // button treatments — but a TOKEN, because the literal here was the old
    // cream palette's `#DFE5ED` and it survived the Nocturne reskin as a pale
    // blue-grey disc against a dark ground. Visible behind a photo only while
    // it loads, which is why nothing caught it until a simulator screenshot.
    backgroundColor: theme.surface,
    borderWidth: 2,
    borderColor: theme.surface,
    ...shadow.sm,
  },
  // A second centring box so the contents cannot inherit a stray text
  // baseline from a parent — RN resolves `lineHeight` down through Views on
  // iOS.
  inner: { alignItems: "center", justifyContent: "center" },
  photo: { width: PHOTO_SIZE, height: PHOTO_SIZE, borderRadius: PHOTO_SIZE / 2 },
});
