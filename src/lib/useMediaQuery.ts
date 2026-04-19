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
  // Default to false on the server to avoid hydration mismatches; actual
  // value is applied in useEffect after mount.
  const [matches, setMatches] = useState(false);

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
