'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';

interface AppNavbarProps {
  user: { name?: string | null; email?: string | null; image?: string | null };
  tripName?: string;
  tripsHref?: string;
  rightSlot?: React.ReactNode;
  isAdmin?: boolean;
}

export default function AppNavbar({ user, tripName, tripsHref = '/trips', rightSlot, isAdmin = false }: AppNavbarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      window.addEventListener('mousedown', onClick);
      return () => window.removeEventListener('mousedown', onClick);
    }
  }, [open]);

  const initials = (user.name || user.email || '?')
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <nav
      className="tp-app-navbar"
      data-trip-context={tripName ? 'trip' : 'app'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: '1px solid var(--tp-border)',
        background: 'rgba(251, 248, 243, 0.92)',
        backdropFilter: 'blur(10px)',
        flexShrink: 0,
        zIndex: 1000,
        boxShadow: 'var(--tp-shadow-sm)',
      }}
    >
      <div
        className="tp-app-navbar__left"
        style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}
      >
        <Link
          href={tripsHref}
          className="tp-app-navbar__brand"
          style={{ color: 'var(--tp-text)', textDecoration: 'none', fontSize: 14, fontWeight: 700 }}
        >
          Feral Travels
        </Link>
        {tripName && (
          <>
            <span className="tp-app-navbar__sep" style={{ color: 'var(--tp-subtle)' }}>/</span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--tp-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {tripName}
            </span>
          </>
        )}
      </div>

      <div
        className="tp-app-navbar__right"
        style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}
      >
        {rightSlot}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'linear-gradient(145deg, var(--tp-primary) 0%, var(--tp-success) 100%)',
              border: '2px solid var(--tp-surface)',
              color: 'var(--tp-on-primary)',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundImage: user.image ? `url(${user.image})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              boxShadow: 'var(--tp-shadow-sm)',
            }}
            aria-label="Account menu"
            title={user.email || user.name || 'Account'}
          >
            {!user.image && initials}
          </button>
          {open && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                width: 220,
                background: 'var(--tp-surface)',
                border: '1px solid var(--tp-border)',
                borderRadius: 'var(--tp-radius-sm)',
                boxShadow: 'var(--tp-shadow-md)',
                overflow: 'hidden',
                zIndex: 2000,
              }}
            >
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--tp-border)' }}>
                {user.name && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tp-text)' }}>{user.name}</div>
                )}
                {user.email && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--tp-subtle)',
                      
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {user.email}
                  </div>
                )}
              </div>
              <Link
                href="/trips"
                onClick={() => setOpen(false)}
                style={{
                  display: 'block',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: 'var(--tp-text)',
                  textDecoration: 'none',
                }}
              >
                Trips
              </Link>
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                style={{
                  display: 'block',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: 'var(--tp-text)',
                  textDecoration: 'none',
                  borderTop: '1px solid var(--tp-border)',
                }}
              >
                Settings
              </Link>
              {isAdmin && (
                <Link
                  href="/admin"
                  onClick={() => setOpen(false)}
                  style={{
                    display: 'block',
                    padding: '10px 14px',
                    fontSize: 13,
                    color: 'var(--tp-gold)',
                    textDecoration: 'none',
                    borderTop: '1px solid var(--tp-border)',
                    
                    letterSpacing: '0.05em',
                  }}
                >
                  Admin
                </Link>
              )}
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: 'var(--tp-danger)',
                  background: 'transparent',
                  border: 'none',
                  borderTop: '1px solid var(--tp-border)',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {/*
        Mobile-friendly tweaks. On a phone, the trip name + vehicle chip
        compete for ~360px of header width, and the brand "Feral Travels /"
        crowds them out. When we're inside a trip context, hide the brand
        text + separator on narrow viewports — the brand is still reachable
        from the avatar dropdown's "Trips" link. App-context navbars (e.g.
        /trips index) keep the brand visible since there's no trip name to
        compete with.
      */}
      <style jsx>{`
        @media (max-width: 480px) {
          .tp-app-navbar {
            padding: 8px 12px !important;
          }
          .tp-app-navbar[data-trip-context='trip'] .tp-app-navbar__brand,
          .tp-app-navbar[data-trip-context='trip'] .tp-app-navbar__sep {
            display: none;
          }
          .tp-app-navbar__left {
            gap: 8px !important;
          }
          .tp-app-navbar__right {
            gap: 8px !important;
          }
        }
      `}</style>
    </nav>
  );
}
