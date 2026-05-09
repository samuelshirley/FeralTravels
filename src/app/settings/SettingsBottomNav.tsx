'use client';

import BottomNav from '@/components/BottomNav';
import { useViewport } from '@/lib/useMediaQuery';

/**
 * Mounts the mobile bottom nav on /settings so users have the same
 * persistent nav they have inside a trip. Settings is a top-level
 * destination on phones — without this, the only way back to the trip
 * list from /settings is the avatar menu.
 *
 * Lives as a leaf client component so the parent /settings page can
 * stay server-rendered.
 *
 * Tablet/desktop don't get the bottom nav at all (it's a phone-only
 * affordance), so we no-op there.
 */
export default function SettingsBottomNav() {
  const viewport = useViewport();
  if (viewport !== 'mobile') return null;
  return <BottomNav active="settings" />;
}
