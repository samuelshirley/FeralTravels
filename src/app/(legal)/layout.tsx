import Link from 'next/link';

/**
 * Shared shell for the public legal pages.
 *
 * A route group, so the URLs stay /privacy and /terms — those exact paths go
 * in the Google OAuth consent screen and in App Store Connect, and they are a
 * pain to change once submitted.
 *
 * Deliberately public: no auth() call, no session read. Google's brand
 * verification and Apple's App Review both fetch these anonymously, and a
 * redirect to /login reads as a broken link to a reviewer.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--tp-bg)',
        padding: '32px 20px 64px',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Link
          href="/"
          style={{
            color: 'var(--tp-primary)',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          ← Feral Travels
        </Link>

        <article className="legal-doc">{children}</article>

        <p style={{ fontSize: 12, color: 'var(--tp-subtle)', marginTop: 40 }}>
          <Link href="/privacy" style={{ color: 'var(--tp-subtle)' }}>
            Privacy
          </Link>
          {' · '}
          <Link href="/terms" style={{ color: 'var(--tp-subtle)' }}>
            Terms
          </Link>
        </p>
      </div>
    </div>
  );
}
