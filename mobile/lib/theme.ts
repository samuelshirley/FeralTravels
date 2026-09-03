/**
 * Native mirror of the web design tokens — the `--tp-*` custom properties
 * declared in `src/app/globals.css`. Every value below is copied
 * character-for-character from that block. If a colour changes on web, change
 * it here and nowhere else.
 *
 * NOTE ON THE CITATIONS: they used to name `src/app/layout.tsx:74-105`. The
 * block moved to `globals.css` in `8768c00` ("stop hand-writing <head>") and
 * roughly twenty-six line references were left pointing at a file that has
 * never contained a token since. Names are cited now rather than line numbers,
 * because a line number is a citation that rots silently.
 *
 * There is NO drift guard on this file — `sharedMirror.test.ts` covers
 * `mobile/shared/` only, and this is not in it. The two palettes stay in step
 * by hand.
 */
export const theme = {
  /* Ground and surfaces */
  bg: "#161826", // --tp-bg
  surface: "#232532", // --tp-surface
  surfaceMuted: "#1f2130", // --tp-surface-muted
  border: "#3f424d", // --tp-border
  borderStrong: "#595d6c", // --tp-border-strong

  /* Text */
  text: "#e9e9ed", // --tp-text
  muted: "#b2b6ca", // --tp-muted
  subtle: "#75798c", // --tp-subtle
  neutral300: "#cfd3e5", // --tp-neutral-300
  neutral900: "#292b31", // --tp-neutral-900 — hairline inside a card

  /* Accent */
  primary: "#9184d9", // --tp-primary
  primaryHover: "#b5abfc", // --tp-primary-hover — LIGHTER, not darker
  primaryMuted: "rgba(145, 132, 217, 0.14)", // --tp-primary-muted
  onPrimary: "#e9e9ed", // --tp-on-primary — never pure white
  accent300: "#d2cefd", // --tp-accent-300
  accent400: "#b5abfc", // --tp-accent-400
  accent700: "#5d5294", // --tp-accent-700
  accent900: "#2b2741", // --tp-accent-900

  /*
   * Folded into the accent by Nocturne's mono rule. Kept as separate keys so
   * the ~50 call sites that mean "this is a fuel thing" or "this succeeded"
   * still say so in code — the palette stopped distinguishing them, the
   * source has not, and re-splitting the hue later is then one edit here.
   */
  success: "#9184d9", // --tp-success
  successMuted: "rgba(145, 132, 217, 0.14)", // --tp-success-muted
  gold: "#9184d9", // --tp-gold — fuel
  accentWarm: "#9184d9", // --tp-accent-warm
  accentWarmMuted: "rgba(145, 132, 217, 0.14)", // --tp-accent-warm-muted
  accentViolet: "#9184d9", // --tp-accent-violet
  accentVioletMuted: "rgba(145, 132, 217, 0.14)", // --tp-accent-violet-muted
  warning: "#d2cefd", // --tp-warning — a real token now, see globals.css
  warningMuted: "rgba(145, 132, 217, 0.14)", // --tp-warning-muted

  /*
   * Danger — the ONE hue kept against the mono rule, and a deliberate
   * departure from the designs, which render Delete as a neutral outline.
   * Lifted from #C65D4A (3.7:1 on this ground, failing as body text) to
   * #E8705C (5.9:1), which stays recognisably the same colour.
   */
  danger: "#E8705C", // --tp-danger
  dangerMuted: "rgba(232, 112, 92, 0.14)", // --tp-danger-muted
  dangerBorder: "rgba(232, 112, 92, 0.4)", // --tp-danger-border

  overlay: "rgba(0, 0, 0, 0.55)", // --tp-overlay
  mapChrome: "#1f2130", // --tp-map-chrome

  /* Radius — 4 / 8 / 14, down from 8 / 12 / 16. */
  radiusSm: 4, // --tp-radius-sm
  radiusMd: 8, // --tp-radius-md
  radiusLg: 14, // --tp-radius-lg

  /** Base days (`leg_type: 'rest'`). The one place a second hue still earns
   *  its keep — Nocturne's `--color-accent-2-500`. Was `#6BA368`. */
  rest: "#9690c9",
  /**
   * Not a web token — native only. The launch-screen purple, kept in step
   * with `expo-splash-screen.backgroundColor` and the Android adaptive-icon
   * background in app.config.js. Any screen that can paint while the native
   * splash is still up uses this so the handover is one continuous colour.
   * Unchanged by the reskin: it is close enough to the new ground that the
   * splash still reads as part of the app.
   */
  splash: "#55346F",
} as const;

/**
 * Spacing, 0.7x density. NEW — there was no scale on either platform, which
 * is why every gap in this app is a literal. Mirrors `--tp-space-*`. Existing
 * literals migrate screen by screen, not in bulk.
 */
export const space = {
  s1: 2.8,
  s2: 5.6,
  s3: 8.4,
  s4: 11.2,
  s5: 16.8,
  s6: 22.4,
} as const;

/**
 * Type scale, mirroring `--tp-text-*`. Hierarchy is size and space, not
 * weight: headings cap at 500 and 600 is reserved for the 9-11px kickers,
 * badges and button labels where it is doing legibility work.
 */
export const type = {
  kicker: 9.5,
  xxs: 10.5,
  xs: 11.5,
  sm: 13,
  base: 14,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 26,
} as const;

/**
 * Elevation. On a dark ground this is an EDGE plus ambient darkness — a soft
 * drop shadow under a dark card is invisible, so `--tp-shadow-sm` is now
 * `0 0 0 1px` and nothing else.
 *
 * `sm` is therefore INERT here rather than a border. Every one of its seven
 * call sites already draws its own edge, and four of them draw a PARTIAL one
 * (`borderTopWidth` on BottomNav and Itinerary, `borderBottomWidth` on
 * TripHeader, `borderWidth: 2` on AccountButton) — a `borderWidth: 1` in this
 * object would spread over the top of each and box in three components that
 * are meant to have one line. The edge belongs at the call site.
 *
 * `md` keeps a real shadow: on a dark ground a modal, the map sheet and the
 * account menu still need to lift off the page, and black at 0.55 does that
 * where a 0.08 grey did nothing.
 */
export const shadow = {
  sm: {
    shadowOpacity: 0,
    elevation: 0,
  },
  md: {
    shadowColor: "#000000",
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
} as const;
