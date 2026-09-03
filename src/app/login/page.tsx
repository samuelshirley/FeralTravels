import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signIn, isAppleSignInConfigured } from '@/server/auth';
import { OtpRateLimitError, retryAfterSeconds, sendOtpCode } from '@/server/auth/otp';

interface LoginPageProps {
  searchParams: { callbackUrl?: string; error?: string; emailError?: string };
}

// Auth.js v5 routes provider failures to /api/auth/error?error=<code>. Map
// the codes we actually see into copy users can act on.
function describeError(code?: string): string | null {
  if (!code) return null;

  // Handle parameterised codes before the switch.
  if (code.startsWith('TypoSuggestion:')) {
    const suggested = code.replace('TypoSuggestion:', '');
    return `Did you mean @${suggested}? Please check your email and try again.`;
  }

  switch (code) {
    case 'OAuthAccountNotLinked':
      return 'This email is already tied to a different sign-in method. Use the Google button above if you usually sign in with Google, or enter your email again to get a new code.';
    case 'InvalidEmail':
      return "That doesn't look like a valid email address. Please double-check and try again.";
    case 'EmailSendFailed':
    case 'Configuration':
      return "Couldn't send your sign-in code. Try Google sign-in or contact support.";
    case 'AccessDenied':
      return 'Access denied. If you think this is a mistake, contact support.';
    case 'RateLimited':
      // Reachable only as a fallback now: the email form sends a throttled
      // user forward to the code screen rather than back here, because a
      // pending code means the next step is entering it, not being scolded.
      return 'A code is already on its way to that address. Check your inbox — it is still valid.';
    default:
      return `Sign-in failed: ${code}`;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl || '/trips';
  if (session?.user) redirect(callbackUrl);

  const errorMessage =
    describeError(searchParams.error) ||
    (searchParams.emailError ? describeError(searchParams.emailError) : null);

  return (
    <div
      style={{
        // 100dvh, not 100vh: mobile browsers (iOS Safari, iOS Chrome which
        // is WebKit under the hood, Android Chrome) compute 100vh against
        // the *toolbar-collapsed* viewport. With the URL bar visible the box
        // ends up taller than the visible area, and `align-items: center`
        // centres against that phantom taller box — pushing the card below
        // the real centre. dvh is the dynamic viewport height (Chrome 108+,
        // Safari 15.4+) and tracks the actually-visible area as toolbars
        // come and go.
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(12px, 4vw, 24px)',
        background: 'var(--tp-bg)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--tp-surface)',
          border: '1px solid var(--tp-border)',
          borderRadius: 'var(--tp-radius-md)',
          padding: 'clamp(20px, 5vw, 32px)',
          color: 'var(--tp-text)',
          boxShadow: 'var(--tp-shadow-md)',
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: 'var(--tp-subtle)',
            marginBottom: 6,
          }}
        >
          FERAL TRAVELS
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, marginBottom: 4 }}>Password-less Sign in / Sign-up</h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--tp-muted)',
            margin: 0,
            marginBottom: 24,
            lineHeight: 1.5,
          }}
        >
          Sign in with Google, or enter your email and we&apos;ll send you a 6-digit code. The same
          email always maps to one account.
          <br />
          <br />
          passwords are dumb
        </p>

        {errorMessage && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--tp-radius-sm)',
              background: 'var(--tp-danger-muted)',
              border: '1px solid rgba(198, 93, 74, 0.35)',
              color: 'var(--tp-danger)',
              fontSize: 12,
              marginBottom: 16,
            }}
          >
            {errorMessage}
          </div>
        )}

        {/* Google */}
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: callbackUrl });
          }}
        >
          <button
            type="submit"
            data-testid="login-google-button"
            style={{
              width: '100%',
              padding: '12px 16px',
              background: 'var(--tp-surface)',
              color: 'var(--tp-text)',
              border: '1px solid var(--tp-border-strong)',
              borderRadius: 'var(--tp-radius-sm)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              boxShadow: 'var(--tp-shadow-sm)',
            }}
          >
            <span style={{ fontWeight: 800 }}>G</span>
            Continue with Google
          </button>
        </form>

        {/* Apple — rendered only when AUTH_APPLE_ID + AUTH_APPLE_SECRET exist.
            Guideline 4.8 (Google implies Apple) governs the iOS app, not this
            page, so on web this sits below Google rather than above it. */}
        {isAppleSignInConfigured && (
          <form
            action={async () => {
              'use server';
              await signIn('apple', { redirectTo: callbackUrl });
            }}
          >
            <button
              type="submit"
              data-testid="login-apple-button"
              style={{
                width: '100%',
                padding: '12px 16px',
                marginTop: 10,
                background: 'var(--tp-surface)',
                color: 'var(--tp-text)',
                border: '1px solid var(--tp-border-strong)',
                borderRadius: 'var(--tp-radius-sm)',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                boxShadow: 'var(--tp-shadow-sm)',
              }}
            >
              <span style={{ fontWeight: 800 }}>&#63743;</span>
              Continue with Apple
            </button>
          </form>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '20px 0 16px',
            color: 'var(--tp-subtle)',
            fontSize: 11,
            letterSpacing: '0.1em',
          }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--tp-border)' }} />
          OR EMAIL
          <div style={{ flex: 1, height: 1, background: 'var(--tp-border)' }} />
        </div>

        {/* Email / OTP */}
        <form
          action={async (formData: FormData) => {
            'use server';
            const email = String(formData.get('email') || '').trim();
            if (!email) return;

            // Basic sanity check: the browser's type="email" validation is
            // client-side only and easily bypassed. Catch obvious typos like
            // missing TLD, bad format, or misspelled common domains before we
            // burn a Resend call on an undeliverable address.
            const emailRe = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
            if (!emailRe.test(email)) {
              redirect(
                `/login?emailError=${encodeURIComponent('InvalidEmail')}&callbackUrl=${encodeURIComponent(callbackUrl)}`
              );
              return;
            }

            // Catch common domain typos (gmail.con, gmail.cmo, hotmal.com, etc.)
            const domain = email.split('@')[1].toLowerCase();
            const domainTypos: Record<string, string> = {
              'gmail.con': 'gmail.com', 'gmail.cmo': 'gmail.com', 'gmial.com': 'gmail.com',
              'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
              'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
              'outloo.com': 'outlook.com', 'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com',
              'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com',
              'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com',
            };
            if (domainTypos[domain]) {
              redirect(
                `/login?emailError=${encodeURIComponent('TypoSuggestion:' + domainTypos[domain])}&callbackUrl=${encodeURIComponent(callbackUrl)}`
              );
              return;
            }

            // Send OTP code and redirect to the verify screen.
            try {
              await sendOtpCode(email);
            } catch (err) {
              /**
               * Being throttled here is not a failed sign-in — it means a
               * code for this address is already in flight. Bouncing back to
               * this page with a red error made the user re-enter an address
               * that had already worked; forward to the code screen instead,
               * which is where they were going anyway, and let it run the
               * countdown on the resend button.
               */
              if (err instanceof OtpRateLimitError) {
                redirect(
                  `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}&retryAfter=${retryAfterSeconds(err.retryAfterMs)}`
                );
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              const code = message.startsWith('EmailSendFailed')
                ? 'EmailSendFailed'
                : 'Configuration';
              console.error('[login] OTP send failed:', message);
              redirect(
                `/login?emailError=${encodeURIComponent(code)}&callbackUrl=${encodeURIComponent(callbackUrl)}`
              );
              return;
            }

            redirect(
              `/login/verify?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}`
            );
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <input
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            style={{
              padding: '10px 14px',
              background: 'var(--tp-surface-muted)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-sm)',
              color: 'var(--tp-text)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            type="submit"
            style={{
              padding: '10px 16px',
              background: 'var(--tp-primary)',
              color: 'var(--tp-on-primary)',
              border: 'none',
              borderRadius: 'var(--tp-radius-sm)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Email me a code
          </button>
        </form>

        {/* Both Google's brand verification and Apple's App Review look for
            reachable legal links on the sign-in surface. Keeping them here
            rather than in a global footer means they sit on the one page a
            reviewer is guaranteed to see. */}
        <p
          style={{
            marginTop: 20,
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--tp-subtle)',
          }}
        >
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
