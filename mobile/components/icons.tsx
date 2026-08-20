import Svg, { Circle, Path } from "react-native-svg";

/**
 * Single source of truth for iconography.
 *
 * Every `d`, `viewBox`, `strokeWidth`, `fill` and `stroke` below is copied
 * character-for-character out of the inline `<svg>` in the web app — the
 * source file and line is named above each icon. Nothing here is redrawn or
 * approximated: if the web changes a path, change it here and nowhere else.
 *
 * The web draws all of these as `fill="none" stroke="currentColor"` with
 * `strokeLinecap="round" strokeLinejoin="round"`, so `color` is the single
 * knob callers turn, exactly like `currentColor` on the web.
 */
interface IconProps {
  /** Maps to the web's `currentColor`. */
  color: string;
  /**
   * Square size in px. Defaults to the size the web renders this icon at, so
   * callers only pass it when the web itself uses more than one size.
   */
  size?: number;
  /** Web-side inline opacity, where the web sets one. */
  opacity?: number;
}

/* ── src/components/BottomNav.tsx:40-46 (iconPath) + 110-121 (the <svg>) ──── */
export function ListIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/BottomNav.tsx:47-53 (iconPath) + 110-121 (the <svg>) ──── */
export function MapIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13 6-3m-6 3V7m6 10 5.553 2.276A1 1 0 0 0 22 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/BottomNav.tsx:54-61 (iconPath) + 110-121 (the <svg>) ──── */
export function ChatIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/BottomNav.tsx:62-68 (iconPath) + 110-121 (the <svg>) ──── */
export function SettingsIcon({ color, size = 22 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.5 7.5 0 0 0-.1-1.4l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-2.4-1.4L14 2h-4l-.5 2.6a7.5 7.5 0 0 0-2.4 1.4l-2.5-1-2 3.5L4.7 10.6a7.5 7.5 0 0 0 0 2.8l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 2.4 1.4L10 22h4l.5-2.6a7.5 7.5 0 0 0 2.4-1.4l2.5 1 2-3.5-2.1-1.6c.07-.45.1-.92.1-1.4Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/AppNavbar.tsx:85-96 — the "← Trips" back affordance ───── */
export function ChevronLeftIcon({ color, size = 14 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18l-6-6 6-6"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/*
 * ── src/app/trips/TripsList.tsx:97-100 — "Edit trips" toggle ──────────────
 * NOTE: this is NOT the same path data as the Itinerary rename pencil below.
 * The web has two hand-written variants (arc sweep flag and the closing
 * segment differ); both are reproduced verbatim rather than unified.
 */
export function PencilEditTripsIcon({ color, size = 12 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 20h9" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/Itinerary.tsx:474-487 — "Rename trip" button ─────────── */
export function PencilRenameIcon({ color, size = 16 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 20h9" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/TripVehicleChip.tsx:48-50 — trip vehicle chip ─────────── */
export function TruckIcon({ color, size = 14, opacity = 0.55 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" opacity={opacity}>
      <Path
        d="M14 16.5h-4M5 16.5h2M17 16.5h2M5 16.5l2-7h10l2 7M7 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/ChatPanel.tsx:2133-2135 — composer attach button ──────── */
export function PaperclipIcon({ color, size = 16 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ── src/components/ChatPanel.tsx:2246-2249 — composer send button ────────── */
export function SendArrowIcon({ color, size = 16 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 19V5" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m5 12 7-7 7 7" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/* ── src/components/AppNavbar.tsx (AccountGlyph) ───────────────────────────
   The generic account bust shown in the navbar avatar. Same two shapes, same
   viewBox, same strokeWidth as the web glyph. Nothing identity-bearing has
   ever been drawn here: no photo, no initials.                            */
export function AccountIcon({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={7} r={4} stroke={color} strokeWidth={2} />
    </Svg>
  );
}
