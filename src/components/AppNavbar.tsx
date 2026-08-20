'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { sanitizeAvatarUrl } from '@/lib/avatarUrl';
import SupportModal from './SupportModal';

/**
 * The fallback account glyph — what everyone without a Google photo gets.
 *
 * It replaced the user's initials, which were both identity on screen for no
 * reason and impossible to centre reliably: a two-letter `<Text>` centres on
 * the FONT's line box, not the glyph, so Onest ExtraBold sat visibly high in
 * a 32pt circle on iOS. This is positioned off the 24-unit viewBox alone, so
 * geometry does the centring. `mobile/components/icons.tsx` carries the
 * character-for-character twin — change one, change both.
 */
function AccountGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: 'block' }}
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

interface AppNavbarProps {
  /** Straight off the Auth.js session; `image` is the Google profile photo. */
  user: { name?: string | null; email?: string | null; image?: string | null };
  tripName?: string;
  tripsHref?: string;
  rightSlot?: React.ReactNode;
  isAdmin?: boolean;
}

export default function AppNavbar({ user, tripName, tripsHref = '/trips', rightSlot, isAdmin = false }: AppNavbarProps) {
  const [open, setOpen] = useState(false);
  /**
   * Hover/focus state for the "Signed in as" card. Kept in React rather than
   * done with a CSS `:hover` rule because the card must also appear on
   * keyboard focus and must NOT appear while the menu is open (the menu
   * already shows the address, and two overlapping panels read as a bug).
   */
  const [hinting, setHinting] = useState(false);
  /**
   * A photo URL that fails to load falls back to the glyph for the rest of
   * the page. Google's avatar URLs go stale when the user changes their
   * picture, and the stored one is only refreshed at the next sign-in.
   */
  const [photoBroken, setPhotoBroken] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
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

  const signedInAs = user.email || user.name || null;

  /**
   * The avatar is the Google profile photo when there is one, and the generic
   * glyph otherwise. There is deliberately no third case: initials are gone
   * (2026-08-20). A user who signed in with an emailed code, or with Apple —
   * whose ID token carries no `picture` claim, ever — gets the glyph, not
   * their own letters.
   *
   * `user.image` is only ever written from a verified Google token and passes
   * the `sanitizeAvatarUrl` host allowlist before it is stored, so what lands
   * here is a `*.googleusercontent.com` URL or nothing.
   */
  const photo = photoBroken ? null : sanitizeAvatarUrl(user.image);

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
        <div
          ref={ref}
          style={{ position: 'relative' }}
          onMouseEnter={() => setHinting(true)}
          onMouseLeave={() => setHinting(false)}
        >
          <button
            type="button"
            className="tp-app-navbar__account-btn"
            onClick={() => setOpen((v) => !v)}
            onFocus={() => setHinting(true)}
            onBlur={() => setHinting(false)}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '2px solid var(--tp-surface)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // No padding: the glyph is centred by the flex box above, and
              // any UA button padding would push a 32px box off its own centre.
              padding: 0,
              boxShadow: 'var(--tp-shadow-sm)',
              appearance: 'none',
              WebkitAppearance: 'none',
              // Opaque literals rather than the 14%-opacity CSS var: iOS
              // standalone (PWA) mode applies UA button resets that can drop a
              // translucent background, leaving the glyph invisible on white.
              // The photo covers this entirely; it shows through only in the
              // instant before the image loads, and if it never does.
              background: '#DFE5ED',
              color: '#4E7AB0',
              overflow: 'hidden',
            }}
            aria-label={signedInAs ? `Account menu — signed in as ${signedInAs}` : 'Account menu'}
            aria-expanded={open}
            aria-haspopup="menu"
          >
            {photo ? (
              /*
                A plain <img>, not next/image: the host is a third party we do
                not want to proxy or optimise through our own bandwidth, and
                at 28px there is nothing to optimise. `onError` matters — a
                Google avatar URL rots when the user changes their photo, and
                without this the button would show a broken-image icon
                forever instead of falling back to the glyph.
              */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo}
                alt=""
                width={28}
                height={28}
                referrerPolicy="no-referrer"
                onError={() => setPhotoBroken(true)}
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <AccountGlyph />
            )}
          </button>
          {/*
            "Signed in as <address>" on hover and on keyboard focus. This
            replaces the old native `title` tooltip, which took a second to
            appear, could not be styled, and never showed on focus at all.
            Suppressed while the menu is open — the menu says the same thing.
          */}
          {hinting && !open && signedInAs && (
            <div
              role="tooltip"
              className="tp-app-navbar__account-hint"
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 8px)',
                maxWidth: 260,
                padding: '6px 10px',
                background: 'var(--tp-surface)',
                border: '1px solid var(--tp-border)',
                borderRadius: 'var(--tp-radius-sm)',
                boxShadow: 'var(--tp-shadow-md)',
                zIndex: 2000,
                // The card is a label, not a target: swallowing the pointer
                // here would make the button flicker as the cursor crossed it.
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <div style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--tp-subtle)' }}>
                Signed in as
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tp-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {signedInAs}
              </div>
            </div>
          )}
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
                <div
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--tp-subtle)',
                    marginBottom: 2,
                  }}
                >
                  Signed in as
                </div>
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
                onClick={() => {
                  setOpen(false);
                  setSupportOpen(true);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  fontSize: 13,
                  color: 'var(--tp-text)',
                  background: 'transparent',
                  border: 'none',
                  borderTop: '1px solid var(--tp-border)',
                  cursor: 'pointer',
                }}
              >
                Contact Support
              </button>
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

      <SupportModal open={supportOpen} onClose={() => setSupportOpen(false)} />

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

        /* iOS standalone (PWA) mode and native button :active / :focus can
           repaint with system colors, washing the glyph out. Pin the solid
           palette across every state so the button is always legible. */
        .tp-app-navbar__account-btn,
        .tp-app-navbar__account-btn:hover,
        .tp-app-navbar__account-btn:active,
        .tp-app-navbar__account-btn:focus,
        .tp-app-navbar__account-btn:focus-visible {
          background: #DFE5ED !important;
          color: #4E7AB0 !important;
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
