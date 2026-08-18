/**
 * Single source of truth for type on native.
 *
 * The web loads Onest via `next/font/google` in src/app/layout.tsx:7-12 with
 * `weight: ['400', '500', '600', '700', '800']`, and applies it to everything
 * through `--tp-font-sans` on `body` (src/app/layout.tsx:75, 120).
 *
 * React Native does NOT synthesise a family from `fontWeight` for a custom
 * font: `fontFamily` has to name the exact static face. So every weight the
 * web uses maps to one @expo-google-fonts/onest family name here, and screens
 * set `fontFamily` instead of `fontWeight`.
 */
export const font = {
  /** CSS font-weight: 400 */
  regular: "Onest_400Regular",
  /** CSS font-weight: 500 */
  medium: "Onest_500Medium",
  /** CSS font-weight: 600 */
  semibold: "Onest_600SemiBold",
  /** CSS font-weight: 700 */
  bold: "Onest_700Bold",
  /** CSS font-weight: 800 */
  extrabold: "Onest_800ExtraBold",
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
