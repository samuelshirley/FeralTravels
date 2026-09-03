'use client';

import Link from 'next/link';
import { ChatIcon, ListIcon, MapIcon, SettingsIcon } from '@/components/icons';

export type MobileTab = 'list' | 'map' | 'chat';

interface BottomNavProps {
  /**
   * Which tab is currently highlighted. `'settings'` highlights the gear;
   * `undefined` leaves no item highlighted (used on pages like /admin
   * that aren't reachable via any of the four nav items).
   */
  active?: MobileTab | 'settings';
  /**
   * Tab change handler. Optional because the nav can be mounted on pages
   * with no trip context (e.g. /settings, /trips index, /admin). When
   * absent, list/map/chat become Links to `/trips` instead of buttons.
   */
  onChange?: (tab: MobileTab) => void;
  thinking?: boolean;
  unread?: number;
}

interface NavItem {
  id: MobileTab | 'settings';
  label: string;
  badge?: 'thinking' | number;
  href?: string;
}

export default function BottomNav({ active, onChange, thinking = false, unread = 0 }: BottomNavProps) {
  // When there's no `onChange` (e.g. mounted on /settings), the trip-tab
  // items can't toggle a parent state — so we route them to /trips instead.
  // The user picked "go_to_trips_index" in the design Q&A: simplest, reuses
  // the existing trips list view as a hub.
  const tripsHref = onChange ? undefined : '/trips';

  const items: NavItem[] = [
    {
      id: 'list',
      label: 'List',
      href: tripsHref,
    },
    {
      id: 'map',
      label: 'Map',
      href: tripsHref,
    },
    {
      id: 'chat',
      label: 'Chat',
      badge: thinking ? 'thinking' : unread > 0 ? unread : undefined,
      href: tripsHref,
    },
    {
      id: 'settings',
      label: 'Settings',
      href: '/settings',
    },
  ];

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'rgba(31, 33, 48, 0.95)',  // --tp-surface-muted @ 95%, behind the blur
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderTop: '1px solid var(--tp-border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        zIndex: 1000,
        boxShadow: '0 -4px 16px rgba(51,51,51,0.06)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${items.length}, 1fr)`,
        }}
      >
        {items.map((item) => {
          const isActive = item.id === active;
          const color = isActive ? 'var(--tp-primary)' : 'var(--tp-muted)';

          const inner = (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 3,
                padding: '12px 4px 12px',
                color,
                position: 'relative',
              }}
            >
              <div style={{ position: 'relative', lineHeight: 0 }}>
                <NavGlyph id={item.id} active={isActive} />
                {item.badge === 'thinking' && (
                  <span
                    aria-label="Penny is thinking"
                    style={{
                      position: 'absolute',
                      top: -2,
                      right: -4,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--tp-success)',
                      animation: 'tp-pulse 1.2s ease-in-out infinite',
                      boxShadow: '0 0 0 0 rgba(145,132,217,0.45)',
                    }}
                  />
                )}
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -8,
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      borderRadius: 8,
                      background: 'var(--tp-accent-warm)',
                      color: 'var(--tp-on-primary)',
                      fontSize: 10,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: '0.05em',
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                {item.label.toUpperCase()}
              </span>
            </div>
          );

          if (item.href) {
            return (
              <Link
                key={item.id}
                href={item.href}
                style={{ textDecoration: 'none', WebkitTapHighlightColor: 'transparent' }}
              >
                {inner}
              </Link>
            );
          }

          return (
            <button
              key={item.id}
              onClick={() => onChange?.(item.id as MobileTab)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {inner}
            </button>
          );
        })}
      </div>
      <style jsx>{`
        @keyframes tp-pulse {
          0%, 100% { opacity: 0.5; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.15); }
        }
      `}</style>
    </nav>
  );
}

/**
 * Tab glyphs, mirroring `NavGlyph` in mobile/components/BottomNav.tsx.
 *
 * Nocturne marks the selected tab by FILLING the glyph, not by shifting its
 * hue. The colour change stays — the two together are what make a 22px icon
 * read as selected without reading the label.
 */
function NavGlyph({ id, active }: { id: MobileTab | 'settings'; active: boolean }) {
  const weight = active ? 'fill' : 'regular';
  if (id === 'list') return <ListIcon weight={weight} />;
  if (id === 'map') return <MapIcon weight={weight} />;
  if (id === 'chat') return <ChatIcon weight={weight} />;
  return <SettingsIcon weight={weight} />;
}
