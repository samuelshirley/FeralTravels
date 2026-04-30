'use client';

import Link from 'next/link';

export type MobileTab = 'list' | 'map' | 'chat';

interface BottomNavProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  thinking?: boolean;
  unread?: number;
}

interface NavItem {
  id: MobileTab | 'settings';
  label: string;
  iconPath: string;
  badge?: 'thinking' | number;
  href?: string;
}

export default function BottomNav({ active, onChange, thinking = false, unread = 0 }: BottomNavProps) {
  const items: NavItem[] = [
    {
      id: 'list',
      label: 'List',
      iconPath:
        'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    },
    {
      id: 'map',
      label: 'Map',
      iconPath:
        'M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13 6-3m-6 3V7m6 10 5.553 2.276A1 1 0 0 0 22 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7',
    },
    {
      id: 'chat',
      label: 'Chat',
      iconPath:
        'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
      badge: thinking ? 'thinking' : unread > 0 ? unread : undefined,
    },
    {
      id: 'settings',
      label: 'Settings',
      iconPath:
        'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.5 7.5 0 0 0-.1-1.4l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-2.4-1.4L14 2h-4l-.5 2.6a7.5 7.5 0 0 0-2.4 1.4l-2.5-1-2 3.5L4.7 10.6a7.5 7.5 0 0 0 0 2.8l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 2.4 1.4L10 22h4l.5-2.6a7.5 7.5 0 0 0 2.4-1.4l2.5 1 2-3.5-2.1-1.6c.07-.45.1-.92.1-1.4Z',
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
        background: 'rgba(251, 248, 243, 0.95)',
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
                padding: '8px 4px 8px',
                color,
                position: 'relative',
              }}
            >
              <div style={{ position: 'relative', lineHeight: 0 }}>
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={item.iconPath} />
                </svg>
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
                      boxShadow: '0 0 0 0 rgba(74,139,122,0.45)',
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
              onClick={() => onChange(item.id as MobileTab)}
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
