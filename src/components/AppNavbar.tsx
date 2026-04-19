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
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(13,13,13,0.95)',
        backdropFilter: 'blur(10px)',
        flexShrink: 0,
        zIndex: 1000,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <Link
          href={tripsHref}
          style={{ color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 700 }}
        >
          Trip Planner
        </Link>
        {tripName && (
          <>
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>/</span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.85)',
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {rightSlot}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #7CB5E8 0%, #7CE8A3 100%)',
              border: 'none',
              color: '#000',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundImage: user.image ? `url(${user.image})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
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
                background: '#1A1A1A',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                overflow: 'hidden',
                zIndex: 2000,
              }}
            >
              <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {user.name && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{user.name}</div>
                )}
                {user.email && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.45)',
                      fontFamily: "'JetBrains Mono', monospace",
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
                  color: 'rgba(255,255,255,0.85)',
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
                  color: 'rgba(255,255,255,0.85)',
                  textDecoration: 'none',
                  borderTop: '1px solid rgba(255,255,255,0.04)',
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
                    color: '#E8C17C',
                    textDecoration: 'none',
                    borderTop: '1px solid rgba(255,255,255,0.04)',
                    fontFamily: "'JetBrains Mono', monospace",
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
                  color: '#E8927C',
                  background: 'transparent',
                  border: 'none',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
