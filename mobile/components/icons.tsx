import type { IconWeight } from "phosphor-react-native";
import {
  ArrowUpIcon,
  CaretDownIcon,
  CaretLeftIcon,
  GasPumpIcon,
  MapPinIcon,
  NavigationArrowIcon,
  WarningIcon as PhosphorWarningIcon,
  XIcon,
  ChatTeardropIcon,
  GearSixIcon,
  ListDashesIcon,
  MapTrifoldIcon,
  PaperclipIcon as PhosphorPaperclipIcon,
  PencilSimpleIcon,
  TruckIcon as PhosphorTruckIcon,
  UserIcon,
} from "phosphor-react-native";

/**
 * Single source of truth for iconography.
 *
 * Until the Nocturne reskin every icon here was a hand-transcribed copy of an
 * inline `<svg>` in the web app — every `d`, `viewBox` and `strokeWidth`
 * carried across by hand, with a `src/components/…:line` comment above each
 * one naming where it came from. That is now Phosphor on both platforms
 * (`phosphor-react-native` here, `@phosphor-icons/react` on the web), so the
 * two share one set and a path is never transcribed again.
 *
 * THE WRAPPERS STAY, and are not ceremony. Call sites pass `color` as a
 * required prop and rely on a per-icon default `size` — the size the web
 * happens to render that icon at — so importing Phosphor directly at ~40 call
 * sites would mean restating a magic number at each. Keeping the seam also
 * means the next icon-set change is one file again.
 *
 * Sizes below are deliberately UNCHANGED from the hand-drawn set. The reskin
 * respaces these screens, but that happens with the screens; swapping the
 * glyph and resizing it in the same commit would make a visual regression
 * impossible to attribute.
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
  /**
   * Phosphor's stroke weight. `fill` is the active state for bottom-nav tabs
   * and for map/stop markers; everything else is `regular`. This replaces the
   * colour-only active state the nav used to have — a filled glyph reads as
   * selected at a glance in a way that a hue shift on a 20px icon does not.
   */
  weight?: IconWeight;
}

export function ListIcon({ color, size = 22, weight = "regular" }: IconProps) {
  return <ListDashesIcon color={color} size={size} weight={weight} />;
}

export function MapIcon({ color, size = 22, weight = "regular" }: IconProps) {
  return <MapTrifoldIcon color={color} size={size} weight={weight} />;
}

export function ChatIcon({ color, size = 22, weight = "regular" }: IconProps) {
  return <ChatTeardropIcon color={color} size={size} weight={weight} />;
}

export function SettingsIcon({ color, size = 22, weight = "regular" }: IconProps) {
  return <GearSixIcon color={color} size={size} weight={weight} />;
}

export function ChevronLeftIcon({ color, size = 14, weight = "regular" }: IconProps) {
  return <CaretLeftIcon color={color} size={size} weight={weight} />;
}

/** The pencil on the trips list's EDIT TRIPS pill. */
export function PencilEditTripsIcon({ color, size = 12, weight = "regular" }: IconProps) {
  return <PencilSimpleIcon color={color} size={size} weight={weight} />;
}

/** The pencil beside a trip name, for renaming it. */
export function PencilRenameIcon({ color, size = 16, weight = "regular" }: IconProps) {
  return <PencilSimpleIcon color={color} size={size} weight={weight} />;
}

export function TruckIcon({ color, size = 14, opacity = 0.55, weight = "regular" }: IconProps) {
  // Phosphor has no `opacity` prop — it takes a style, and the vehicle chip
  // has always rendered this glyph at 55%.
  return <PhosphorTruckIcon color={color} size={size} weight={weight} style={{ opacity }} />;
}

export function PaperclipIcon({ color, size = 16, weight = "regular" }: IconProps) {
  return <PhosphorPaperclipIcon color={color} size={size} weight={weight} />;
}

export function SendArrowIcon({ color, size = 16, weight = "regular" }: IconProps) {
  return <ArrowUpIcon color={color} size={size} weight={weight} />;
}

export function AccountIcon({ color, size = 18, weight = "regular" }: IconProps) {
  return <UserIcon color={color} size={size} weight={weight} />;
}

/* ── Glyphs that replaced emoji. Nocturne has no emoji: they carry a colour
   and a vendor's drawing style that no palette controls, and they render
   differently on every platform the app ships to. ─────────────────────── */

/** Was `⛽` on a fuel stop. Filled, like every marker. */
export function FuelIcon({ color, size = 14, weight = "fill" }: IconProps) {
  return <GasPumpIcon color={color} size={size} weight={weight} />;
}

/** Was `📍` on a user-added stop. */
export function PlaceIcon({ color, size = 14, weight = "fill" }: IconProps) {
  return <MapPinIcon color={color} size={size} weight={weight} />;
}

/** Was `▶` on a navigate action. */
export function NavigateIcon({ color, size = 14, weight = "regular" }: IconProps) {
  return <NavigationArrowIcon color={color} size={size} weight={weight} />;
}

/** Was `▾` on a disclosure. */
export function DisclosureIcon({ color, size = 12, weight = "regular" }: IconProps) {
  return <CaretDownIcon color={color} size={size} weight={weight} />;
}

/** Was `⚠` on the leg-continuity warning. */
export function WarningIcon({ color, size = 14, weight = "regular" }: IconProps) {
  return <PhosphorWarningIcon color={color} size={size} weight={weight} />;
}

/** Was `×` on a remove control. */
export function CloseIcon({ color, size = 12, weight = "bold" }: IconProps) {
  return <XIcon color={color} size={size} weight={weight} />;
}
