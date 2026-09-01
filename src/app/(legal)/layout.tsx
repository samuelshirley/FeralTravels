import Link from 'next/link';

/**
 * Shared shell for the public legal pages.
 *
 * STANDALONE. No header, no app navigation, nothing that routes into the
 * product — see the wordmark comment below. Nobody reads these; they exist
 * because Apple and Google require them, and the only job of this shell is to
 * present the document to a reviewer without offering them a way to get lost.
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
        {/*
          A wordmark, NOT a link. These pages are standalone on purpose.

          It used to be `← Feral Travels` pointing at `/`, which was fine when
          the web was the product. It is not now: `/` redirects to the download
          screen, so the only navigation a reviewer was offered led out of the
          document they were sent to read and into a prompt to install an app
          they are in the middle of reviewing.

          Nothing here routes into the app. The three legal pages cross-link to
          each other — Apple and Google both expect to get between them — and
          /support carries a mailto. That is the whole navigation surface.
        */}
        <div
          style={{
            color: 'var(--tp-muted)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Feral Travels
        </div>

        <article className="legal-doc">{children}</article>

        <p style={{ fontSize: 12, color: 'var(--tp-subtle)', marginTop: 40 }}>
          <Link href="/privacy" style={{ color: 'var(--tp-subtle)' }}>
            Privacy
          </Link>
          {' · '}
          <Link href="/terms" style={{ color: 'var(--tp-subtle)' }}>
            Terms
          </Link>
          {' · '}
          <Link href="/support" style={{ color: 'var(--tp-subtle)' }}>
            Support
          </Link>
        </p>
      </div>
    </div>
  );
}
