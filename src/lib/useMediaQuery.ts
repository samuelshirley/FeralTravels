'use client';

import { useEffect, useState, useRef } from 'react';
import { useViewportHint } from '@/components/ViewportHintContext';

// The breakpoints live in `lib/breakpoints.ts` (a plain module) so the
// server-rendered layout can use them too; re-exported here for the callers
// that always imported them from this file.
export { BREAKPOINTS, type Viewport } from '@/lib/breakpoints';
import { BREAKPOINTS } from '@/lib/breakpoints';
import type { Viewport } from '@/lib/breakpoints';

export function useMediaQuery(query: string, initial = false): boolean {
  /*
   * IMPORTANT: the initial value must be something the SERVER also knew. It
   * must NOT come from `window.matchMedia` — reading that in the useState
   * initializer produced a client value that differed from the server markup
   * and triggered hydration errors #425 / #418 / #423 on every mobile load.
   *
   * `initial` is how the server's knowledge gets in: `useViewport` passes the
   * viewport HINT the request carried as a cookie (see `lib/viewportHint.ts`),
   * so on a reload the server renders the phone's tree and the first client
   * render agrees with it. With no hint this is `false` — desktop first, then
   * the post-hydration correction.
   *
   * That correction is NOT "sub-frame and invisible", which is what this
   * comment used to claim. It was true for `MobileFooter`, which toggles one
   * small element; it is false for `TripWorkspace`, which returns a different
   * component tree per viewport, so a phone painted the two-pane desktop
   * workspace at 430px and then unmounted it for the mobile tree — two whole
   * trees, visibly, on every reload (2026-09-04). The hint is what makes the
   * reload case right; the very first visit of a fresh browser still does the
   * one swap, once.
   */
  const [matches, setMatches] = useState(initial);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const apply = () => setMatches(mql.matches);
    apply(); // sync to current value immediately post-hydration
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [query]);

  return matches;
}

const MOBILE_QUERY = `(max-width: ${BREAKPOINTS.tablet - 1}px)`;
const TABLET_QUERY = `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`;
const DESKTOP_QUERY = `(min-width: ${BREAKPOINTS.desktop}px)`;

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY, useViewportHint() === 'mobile');
}

export function useIsTablet(): boolean {
  return useMediaQuery(TABLET_QUERY, useViewportHint() === 'tablet');
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY, useViewportHint() === 'desktop');
}

export function useViewport(): Viewport {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  if (isMobile) return 'mobile';
  if (isTablet) return 'tablet';
  return 'desktop';
}
