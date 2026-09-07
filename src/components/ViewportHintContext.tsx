'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Viewport } from '@/lib/breakpoints';

/**
 * Carries the server's viewport hint (see `lib/viewportHint.ts`) to
 * `useViewport`, which uses it as the INITIAL value — the one that has to
 * match the server markup. Null means "no hint": the hook falls back to the
 * old behaviour (desktop first, then the post-hydration correction).
 */
const ViewportHintContext = createContext<Viewport | null>(null);

export function ViewportHintProvider({
  hint,
  children,
}: {
  hint: Viewport | null;
  children: ReactNode;
}) {
  return <ViewportHintContext.Provider value={hint}>{children}</ViewportHintContext.Provider>;
}

export function useViewportHint(): Viewport | null {
  return useContext(ViewportHintContext);
}
