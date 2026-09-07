/**
 * The viewport breakpoints, in a PLAIN module — no 'use client', no hooks —
 * because both halves of the app need them: the client hook (`useMediaQuery`)
 * and the server-rendered layout that emits the viewport-hint script. A
 * server component that imports a value from a 'use client' module gets a
 * client REFERENCE, not the value, and `BREAKPOINTS.tablet` then throws
 * "Cannot access tablet.toString on the server" on every page (2026-09-04).
 *
 * Mobile  : phones, phablets                          (< 768px)
 * Tablet  : iPad portrait, foldables, small laptops   (768 – 1023px)
 * Desktop : iPad landscape, laptops, monitors         (>= 1024px)
 */
export type Viewport = 'mobile' | 'tablet' | 'desktop';

export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1024,
} as const;

export function viewportFromWidth(width: number): Viewport {
  if (width < BREAKPOINTS.tablet) return 'mobile';
  if (width < BREAKPOINTS.desktop) return 'tablet';
  return 'desktop';
}
