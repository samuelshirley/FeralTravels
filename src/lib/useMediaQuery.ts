'use client';

import { useEffect, useState, useRef } from 'react';

export type Viewport = 'mobile' | 'tablet' | 'desktop';

// Single source of truth for viewport breakpoints.
// Mobile  : phones, phablets                          (< 768px)
// Tablet  : iPad portrait, foldables, small laptops   (768 – 1023px)
// Desktop : iPad landscape, laptops, monitors         (>= 1024px)
export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1024,
} as const;

export function useMediaQuery(query: string): boolean {
  // IMPORTANT: always initialize to `false` so the first client render
  // matches SSR output exactly. The previous approach — reading
  // window.matchMedia in useState's initializer — produced a value on the
  // client that differed from what the server rendered, triggering React
  // hydration errors #425 / #418 / #423 on every mobile page load.
  //
  // The trade-off is a single post-hydration re-render where `matches`
  // flips from false → true on mobile. Components that conditionally
  // render based on viewport (MobileFooter, VehicleRemediationOverlay)
  // were already doing this before the 2026-05-09 "sync init" change;
  // the flicker is sub-frame and invisible because the useEffect fires
  // in the same microtask batch as the hydration commit.
  const [matches, setMatches] = useState(false);

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

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS.tablet - 1}px)`);
}

export function useIsTablet(): boolean {
  return useMediaQuery(
    `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`
  );
}

export function useIsDesktop(): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
}

export function useViewport(): Viewport {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  if (isMobile) return 'mobile';
  if (isTablet) return 'tablet';
  return 'desktop';
}
