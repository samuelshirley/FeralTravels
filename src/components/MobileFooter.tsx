'use client';

import BottomNav, { type MobileTab } from '@/components/BottomNav';
import { useViewport } from '@/lib/useMediaQuery';

interface Props {
  /**
   * Which tab to highlight on this page. Pass `'settings'` on /settings,
   * `'list'` on /trips (it's the trips list), or undefined on pages like
   * /admin that aren't reachable from any of the four nav items.
   */
  active?: MobileTab | 'settings';
}

/**
 * Universal mobile bottom nav for non-trip pages (/trips, /settings, /admin).
 * The trip workspace (/trips/[id]) mounts its own BottomNav directly so it
 * can wire `onChange` to its internal tab state.
 *
 * Hidden on tablet & desktop — the bottom nav is a phone-only affordance
 * (those viewports have side rails / multi-pane layouts instead).
 */
export default function MobileFooter({ active }: Props) {
  const viewport = useViewport();
  if (viewport !== 'mobile') return null;
  return <BottomNav active={active} />;
}
