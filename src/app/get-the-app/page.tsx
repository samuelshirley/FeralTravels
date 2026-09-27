import type { Metadata } from 'next';
import { APP_STORE_URL } from '@/lib/paywallCopy';

/**
 * What a browser sees now that Feral Travels is an iOS app.
 *
 * Not a paywall and not an error. Anyone but the admin who reaches a gated web
 * page — /trips, /signin, an old link, a sign-in email — is sent here. They get
 * what the app is, where to sign in, and a button.
 *
 * The App Store link is `APP_STORE_URL`, which reads `NEXT_PUBLIC_APP_STORE_URL`
 * and falls back to Apple's SEARCH url until the listing id exists. A search
 * page that finds the app is a better failure than a 404 on a guessed id, and
 * it means this page needs no edit on the day the listing goes live.
 *
 * Deliberately server-rendered with no client JS: it is the page a reviewer, a
 * crawler and a stranger on a bad connection all get.
 */
export const metadata: Metadata = {
  title: 'Feral Travels — get the app',
  description: 'Feral Travels is an iPhone app that plans your road trip and finds cheap fuel along the route.',
};

export default function GetTheAppPage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 20px',
        textAlign: 'center',
        background: 'var(--tp-bg, #f5f1ea)',
        color: 'var(--tp-text, #333)',
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: 'var(--tp-muted, #6b6b6b)',
            marginBottom: 10,
          }}
        >
          FERAL TRAVELS
        </div>

        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px', lineHeight: 1.25 }}>
          Feral Travels runs on iPhone
        </h1>

        <p style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--tp-muted, #6b6b6b)', margin: '0 0 22px' }}>
          Plan the route and find cheap fuel along it. Already have an account? Sign in on the app
          with the same email.
        </p>

        <a
          href={APP_STORE_URL}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px 24px',
            borderRadius: 'var(--tp-radius-sm, 8px)',
            background: 'var(--tp-primary, #4E7AB0)',
            color: 'var(--tp-on-primary, #fff)',
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Download on the App Store
        </a>

        {/*
          Kept in the footer of this page specifically. It is the one page a
          reviewer or a crawler is most likely to land on with the web off, and
          the legal pages have to be reachable from wherever somebody lands.
        */}
        <div style={{ marginTop: 28, fontSize: 12, display: 'flex', gap: 16, justifyContent: 'center' }}>
          <a href="/privacy" style={{ color: 'var(--tp-muted, #6b6b6b)' }}>Privacy</a>
          <a href="/terms" style={{ color: 'var(--tp-muted, #6b6b6b)' }}>Terms</a>
          <a href="/support" style={{ color: 'var(--tp-muted, #6b6b6b)' }}>Support</a>
        </div>
      </div>
    </main>
  );
}
