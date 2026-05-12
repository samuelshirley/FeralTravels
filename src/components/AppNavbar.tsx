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

  const hasPhoto = Boolean(user.image?.trim());

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
        {/*
          When inside a trip, the brand slot becomes a "← Trips" back
          affordance so the user always has a one-tap way back to their
          trip list. On non-trip pages (trips index, settings, admin) we
          keep the "Feral Travels" wordmark since there's nothing to back
          out to. Same Link target either way (`tripsHref`).
        */}
        <Link
          href={tripsHref}
          className="tp-app-navbar__brand"
          style={{
            color: 'var(--tp-text)',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
          aria-label={tripName ? 'Back to trips' : 'Feral Travels home'}
        >
          {tripName ? (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
              <span>Trips</span>
            </>
          ) : (
            'Feral Travels'
          )}
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
            type="button"
            className={
              'tp-app-navbar__account-btn ' +
              (hasPhoto ? 'tp-app-navbar__account-btn--photo' : 'tp-app-navbar__account-btn--initials')
            }
            onClick={() => setOpen((v) => !v)}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '2px solid var(--tp-surface)',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--tp-shadow-sm)',
              appearance: 'none',
              WebkitAppearance: 'none',
              ...(hasPhoto
                ? {
                    backgroundImage: `url(${user.image}), linear-gradient(145deg, var(--tp-primary) 0%, var(--tp-success) 100%)`,
                    backgroundSize: 'cover, cover',
                    backgroundPosition: 'center, center',
                    backgroundRepeat: 'no-repeat, no-repeat',
                    color: 'var(--tp-on-primary)',
                  }
                : {
                    background: 'var(--tp-primary-muted)',
                    color: 'var(--tp-primary)',
                  }),
            }}
            aria-label="Account menu"
            title={user.email || user.name || 'Account'}
          >
            {!hasPhoto && initials}
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
        Mobile-friendly tweaks. On a phone the brand slot used to be hidden
        in trip context (it just said "Feral Travels /") to save room for
        the trip name + vehicle chip. As of 2026-05 the brand is now a
        compact "← Trips" back affordance, so we KEEP it visible on mobile
        — that's the one-tap path back to the trips list. We still tighten
        padding/gap on narrow viewports so trip name + vehicle chip have
        room to breathe.
      */}
      <style jsx>{`
        .tp-app-navbar__account-btn {
          -webkit-tap-highlight-color: transparent;
        }

        /* Native button :active / :focus can repaint with system colors and wash out
           initials (white text on cream). Lock the same palette through press + focus. */
        .tp-app-navbar__account-btn--initials:hover,
        .tp-app-navbar__account-btn--initials:active,
        .tp-app-navbar__account-btn--initials:focus,
        .tp-app-navbar__account-btn--initials:focus-visible {
          background: var(--tp-primary-muted) !important;
          color: var(--tp-primary) !important;
        }

        .tp-app-navbar__account-btn--photo:hover,
        .tp-app-navbar__account-btn--photo:active,
        .tp-app-navbar__account-btn--photo:focus,
        .tp-app-navbar__account-btn--photo:focus-visible {
          color: var(--tp-on-primary) !important;
        }

        @media (max-width: 480px) {
          .tp-app-navbar {
            padding: 8px 12px !important;
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
