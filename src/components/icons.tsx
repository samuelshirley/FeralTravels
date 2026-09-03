import {
  ArrowUp,
  CaretDown,
  CaretLeft,
  GasPump,
  Info,
  MapPin,
  NavigationArrow,
  Warning,
  X,
  ChatTeardrop,
  GearSix,
  ListDashes,
  MapTrifold,
  Paperclip,
  PencilSimple,
  Truck,
  User,
} from '@phosphor-icons/react/dist/ssr';
// The SSR entry re-exports the components but not the types; `lib` is where
// they live, and importing the type alone pulls in no client runtime.
import type { IconWeight } from '@phosphor-icons/react/lib';

/**
 * Single source of truth for iconography on the web.
 *
 * NEW with the Nocturne reskin. Before it, web icons were inline `<svg>` with
 * literal `d` attributes scattered across seven components, and
 * `mobile/components/icons.tsx` was a hand-transcription of them — every path,
 * `viewBox` and `strokeWidth` copied across by hand, annotated with the
 * `src/components/…:line` it came from. Both sides are Phosphor now and this
 * file is the web half of that pair. Export names are deliberately IDENTICAL
 * to the native module's, so the two read as one set.
 *
 * Imported from `@phosphor-icons/react/dist/ssr` rather than the package root:
 * the root entry is a client component (it reads an `IconContext`), and these
 * are used from server components too — `EntitlementNotice` is one. The SSR
 * entry drops the context and takes props directly, which is all we want.
 *
 * Sizes below are deliberately UNCHANGED from the hand-drawn set. The reskin
 * respaces these screens, but that happens with the screens; swapping the
 * glyph and resizing it in the same commit would make a visual regression
 * impossible to attribute.
 */
interface IconProps {
  /** Defaults to `currentColor`, which is how every call site drove the old inline SVGs. */
  color?: string;
  /** Square size in px. Defaults to the size this icon has always rendered at. */
  size?: number;
  /** Inline opacity, where a call site sets one. */
  opacity?: number;
  /**
   * Phosphor's stroke weight. `fill` is the active state for bottom-nav tabs
   * and for map/stop markers; everything else is `regular`. This replaces the
   * colour-only active state the nav used to have — a filled glyph reads as
   * selected at a glance in a way that a hue shift on a 20px icon does not.
   */
  weight?: IconWeight;
}

export function ListIcon({ color = 'currentColor', size = 22, weight = 'regular' }: IconProps) {
  return <ListDashes color={color} size={size} weight={weight} />;
}

export function MapIcon({ color = 'currentColor', size = 22, weight = 'regular' }: IconProps) {
  return <MapTrifold color={color} size={size} weight={weight} />;
}

export function ChatIcon({ color = 'currentColor', size = 22, weight = 'regular' }: IconProps) {
  return <ChatTeardrop color={color} size={size} weight={weight} />;
}

export function SettingsIcon({ color = 'currentColor', size = 22, weight = 'regular' }: IconProps) {
  return <GearSix color={color} size={size} weight={weight} />;
}

export function ChevronLeftIcon({ color = 'currentColor', size = 14, weight = 'regular' }: IconProps) {
  return <CaretLeft color={color} size={size} weight={weight} />;
}

/** The pencil on the trips list's EDIT TRIPS pill. */
export function PencilEditTripsIcon({ color = 'currentColor', size = 12, weight = 'regular' }: IconProps) {
  return <PencilSimple color={color} size={size} weight={weight} />;
}

/** The pencil beside a trip name, for renaming it. */
export function PencilRenameIcon({ color = 'currentColor', size = 16, weight = 'regular' }: IconProps) {
  return <PencilSimple color={color} size={size} weight={weight} />;
}

export function TruckIcon({
  color = 'currentColor',
  size = 14,
  opacity = 0.55,
  weight = 'regular',
}: IconProps) {
  return <Truck color={color} size={size} weight={weight} style={{ opacity }} />;
}

export function PaperclipIcon({ color = 'currentColor', size = 16, weight = 'regular' }: IconProps) {
  return <Paperclip color={color} size={size} weight={weight} />;
}

export function SendArrowIcon({ color = 'currentColor', size = 16, weight = 'regular' }: IconProps) {
  return <ArrowUp color={color} size={size} weight={weight} />;
}

export function AccountIcon({ color = 'currentColor', size = 18, weight = 'regular' }: IconProps) {
  return <User color={color} size={size} weight={weight} />;
}

/* ── Glyphs that replaced emoji. Nocturne has no emoji: they carry a colour
   and a vendor's drawing style that no palette controls, and they render
   differently on every platform the app ships to. ─────────────────────── */

/** Was `⛽` on a fuel stop. Filled, like every marker. */
export function FuelIcon({ color = 'currentColor', size = 14, weight = 'fill' }: IconProps) {
  return <GasPump color={color} size={size} weight={weight} />;
}

/** Was `📍` on a user-added stop. */
export function PlaceIcon({ color = 'currentColor', size = 14, weight = 'fill' }: IconProps) {
  return <MapPin color={color} size={size} weight={weight} />;
}

/** Was `▶` on a navigate action. */
export function NavigateIcon({ color = 'currentColor', size = 14, weight = 'regular' }: IconProps) {
  return <NavigationArrow color={color} size={size} weight={weight} />;
}

/** Was `▾` on a disclosure. */
export function DisclosureIcon({ color = 'currentColor', size = 12, weight = 'regular' }: IconProps) {
  return <CaretDown color={color} size={size} weight={weight} />;
}

/** Was `⚠` on the leg-continuity warning. */
export function WarningIcon({ color = 'currentColor', size = 14, weight = 'regular' }: IconProps) {
  return <Warning color={color} size={size} weight={weight} />;
}

/** Was `×` on a remove control. */
export function CloseIcon({ color = 'currentColor', size = 12, weight = 'bold' }: IconProps) {
  return <X color={color} size={size} weight={weight} />;
}

/* ── Brand marks. NOT Phosphor: a provider's logo is their asset and their
   brand guidelines govern it, so these are the official paths and must not
   be restyled, recoloured or swapped for a look-alike. ─────────────────── */

/**
 * Google's four-colour "G".
 *
 * Replaces `<span style={{ fontWeight: 800 }}>G</span>`, which was a bold
 * letter G in the app's own typeface — not Google's mark, and a fail against
 * their brand requirements for a "Continue with Google" button.
 *
 * `currentColor` is deliberately NOT honoured: the four colours are the mark.
 */
export function GoogleMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * The Apple mark.
 *
 * Replaces `&#63743;` — the private-use codepoint that renders the logo only
 * on Apple platforms, and shows a tofu box everywhere else. Takes
 * `currentColor`, unlike Google's, because Apple's guidelines require a solid
 * single-colour mark that matches the button label.
 */
export function AppleMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 384 512"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

/** The info glyph on a neutral notice. */
export function InfoIcon({ color = 'currentColor', size = 15, weight = 'regular' }: IconProps) {
  return <Info color={color} size={size} weight={weight} />;
}
