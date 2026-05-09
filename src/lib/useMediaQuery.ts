'use client';

import { useEffect, useState } from 'react';

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
  // Initialize synchronously from matchMedia when available so the FIRST
  // client render already knows the viewport. The previous "always false"
  // default caused a one-frame flicker where mobile-only UI (e.g. the
  // BottomNav on /settings) flashed off then on after the useEffect ran —
  // and on slower client navigations it could "stick" off until the next
  // re-render, making the footer appear missing entirely (bug 2026-05-09).
  //
  // SSR still gets `false` (no `window`), which is fine: client hydration
  // immediately swaps to the correct value via the lazy initializer and
  // there's no visible mismatch because we never SSR the BottomNav itself
  // (it's only rendered when matches=true).
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const apply = () => setMatches(mql.matches);
    apply();
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
