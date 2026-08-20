import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Support — Feral Travels',
  description: 'Get help with Feral Travels. One person, two dogs, one inbox.',
};

/**
 * Public support page.
 *
 * This exact URL (/support) is the Support URL in App Store Connect. App Review
 * fetches it anonymously, so — like /privacy and /terms — it lives in the
 * (legal) route group: no auth() call, no session read, no redirect to /login.
 * Changing the path means editing the submitted listing, so don't.
 */
const SUPPORT_EMAIL = 'support@feraltravels.com';

export default function SupportPage() {
  return (
    <>
      <h1>Support</h1>
      <p className="updated">Feral Travels for iOS and feraltravels.com</p>

      <figure style={{ margin: '8px 0 28px' }}>
        <img
          src="/support-dogs.jpg"
          alt="Penny and Finn on a pavement, mid-walk, looking up at the camera"
          width={360}
          height={480}
          style={{
            display: 'block',
            width: '100%',
            maxWidth: 320,
            height: 'auto',
            borderRadius: 14,
          }}
        />
        <figcaption
          style={{
            maxWidth: 320,
            marginTop: 12,
            fontSize: 17,
            fontWeight: 600,
            color: 'var(--tp-text)',
            textAlign: 'center',
          }}
        >
          We are doing our best
        </figcaption>
      </figure>

      <p>
        Something broken, a route that makes no sense, a fuel stop in the wrong place, or
        an account you want deleted — it all goes to the same inbox and a real person
        reads it.
      </p>

      <p>
        <a href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a> — {SUPPORT_EMAIL}
      </p>
    </>
  );
}
