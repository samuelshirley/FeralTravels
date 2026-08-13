/**
 * Native mirror of the web design tokens (the --tp-* CSS variables in
 * src/app/layout.tsx). Keep in sync with the web — the app should look like
 * the same product. If a color changes on web, change it here too.
 */
export const theme = {
  bg: "#F6F2EA",
  surface: "#FFFFFF",
  surfaceMuted: "#FBF8F3",
  border: "#E6DFD4",
  borderStrong: "#D4C9BA",
  text: "#333333",
  muted: "#5C5C5C",
  subtle: "rgba(51, 51, 51, 0.45)",
  primary: "#4E7AB0",
  primaryHover: "#3D6799",
  onPrimary: "#FFFFFF",
  danger: "#C65D4A",
  dangerMuted: "rgba(198, 93, 74, 0.12)",
  gold: "#B8956A",
  radiusSm: 8,
  radiusMd: 12,
  radiusLg: 16,
} as const;
