import {
  ArrowUp,
  CaretLeft,
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
