/**
 * Native mirror of the web design tokens — the `--tp-*` CSS custom properties
 * declared in src/app/layout.tsx:74-105. Every value below is copied
 * character-for-character from that block; the line number is named on any
 * token that is easy to get wrong. If a colour changes on web, change it here
 * and nowhere else.
 */
export const theme = {
  bg: "#F6F2EA", // layout.tsx:76  --tp-bg
  surface: "#FFFFFF", // :77  --tp-surface
  surfaceMuted: "#FBF8F3", // :78  --tp-surface-muted
  border: "#E6DFD4", // :79  --tp-border
  borderStrong: "#D4C9BA", // :80  --tp-border-strong
  text: "#333333", // :81  --tp-text
  muted: "#5C5C5C", // :82  --tp-muted
  subtle: "rgba(51, 51, 51, 0.45)", // :83  --tp-subtle
  primary: "#4E7AB0", // :84  --tp-primary
  primaryHover: "#3D6799", // :85  --tp-primary-hover
  primaryMuted: "rgba(78, 122, 176, 0.14)", // :86  --tp-primary-muted
  onPrimary: "#FFFFFF", // :87  --tp-on-primary
  success: "#4A8B7A", // :88  --tp-success
  successMuted: "rgba(74, 139, 122, 0.14)", // :89  --tp-success-muted
  danger: "#C65D4A", // :90  --tp-danger
  dangerMuted: "rgba(198, 93, 74, 0.12)", // :91  --tp-danger-muted
  accentWarm: "#C97B63", // :92  --tp-accent-warm
  accentWarmMuted: "rgba(201, 123, 99, 0.14)", // :93  --tp-accent-warm-muted
  gold: "#B8956A", // :94  --tp-gold
  accentViolet: "#6B5B9A", // :95  --tp-accent-violet
  accentVioletMuted: "rgba(107, 91, 154, 0.14)", // :96  --tp-accent-violet-muted
  overlay: "rgba(51, 51, 51, 0.4)", // :97  --tp-overlay
  radiusSm: 8, // :100 --tp-radius-sm
  radiusMd: 12, // :101 --tp-radius-md
  radiusLg: 16, // :102 --tp-radius-lg
  mapChrome: "#EDE8E0", // :103 --tp-map-chrome

  /*
   * Not `--tp-*` tokens — the web has no `--tp-warning`. src/components/
   * StopsSection.tsx:216 writes `var(--tp-warning, #b7791f)`, i.e. it always
   * falls through to the literal. The muted/solid pair below is the
   * "NEEDS RESEARCH" status swatch from src/types/trip.ts:464, which is the
   * only warning-toned surface the web actually paints.
   */
  warning: "#B8956A", // src/types/trip.ts:464 `text`
  warningMuted: "rgba(184, 149, 106, 0.14)", // src/types/trip.ts:464 `bg`
  /** src/components/LegCard.tsx:195 — `const restDayColor = '#6BA368'`. */
  rest: "#6BA368",
  /**
   * Not a web token — native only. The launch-screen purple, kept in step with
   * `expo-splash-screen.backgroundColor` and the Android adaptive-icon
   * background in app.config.js:81,96. Any screen that can paint while the
   * native splash is still up (the entry gate, the font-loading fallback) uses
   * this so the handover is one continuous colour instead of a cream flash.
   */
  splash: "#55346F",
} as const;

/**
 * --tp-shadow-sm / --tp-shadow-md (src/app/layout.tsx:98-99):
 *   sm: 0 1px 2px  rgba(51, 51, 51, 0.06)
 *   md: 0 4px 12px rgba(51, 51, 51, 0.08)
 * Colour, opacity and offset are the web's. `shadowRadius` has no exact CSS
 * blur-radius equivalent on iOS, so it is the one approximated value here.
 */
export const shadow = {
  sm: {
    shadowColor: "#333333",
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  md: {
    shadowColor: "#333333",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
} as const;
