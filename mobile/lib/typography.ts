/**
 * Single source of truth for type on native.
 *
 * The web loads Inter via `next/font/google` in src/app/layout.tsx with
 * `weight: ['400', '500', '600', '700', '800']`, and applies it to everything
 * through `--tp-font-sans` on `body` (src/app/globals.css).
 *
 * React Native does NOT synthesise a family from `fontWeight` for a custom
 * font: `fontFamily` has to name the exact static face. So every weight the
 * web uses maps to one @expo-google-fonts/inter family name here, and screens
 * set `fontFamily` instead of `fontWeight`.
 *
 * `bold` and `extrabold` are still loaded because call sites still ask for
 * them. Nocturne's rule is that hierarchy is size and space, not weight —
 * headings cap at `medium`, and `semibold` is for the 9-11px kickers, badges
 * and button labels. Those two faces come out once the per-screen sweep has
 * removed the last of them; dropping them now would leave RN rendering the
 * DEFAULT SYSTEM FACE at those call sites, not a synthesised bold.
 */
export const font = {
  /** CSS font-weight: 400 */
  regular: "Inter_400Regular",
  /** CSS font-weight: 500 */
  medium: "Inter_500Medium",
  /** CSS font-weight: 600 */
  semibold: "Inter_600SemiBold",
  /** CSS font-weight: 700 */
  bold: "Inter_700Bold",
  /** CSS font-weight: 800 */
  extrabold: "Inter_800ExtraBold",
} as const;

/** Lookup by the numeric CSS weight, for code that carries a weight around. */
export const fontByWeight = {
  400: font.regular,
  500: font.medium,
  600: font.semibold,
  700: font.bold,
  800: font.extrabold,
} as const;

export type FontFamily = (typeof font)[keyof typeof font];
