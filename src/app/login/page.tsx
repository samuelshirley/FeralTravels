import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signIn, isAppleSignInConfigured } from '@/server/auth';
import { OtpRateLimitError, retryAfterSeconds, sendOtpCode } from '@/server/auth/otp';
import { AppleMark, GoogleMark, InfoIcon } from '@/components/icons';

interface LoginPageProps {
  searchParams: { callbackUrl?: string; error?: string; emailError?: string };
}

/**
 * Auth.js v5 routes provider failures to /api/auth/error?error=<code>.
 *
 * ONE ACCOUNT, THREE DOORS. Google, Apple and an emailed code all resolve to
 * the same user id, keyed on the verified address, and a user may take any of
 * them on any visit. So this deliberately no longer handles:
 *
 *   - `OAuthAccountNotLinked`. It told a Google user that their address was
 *     "tied to a different sign-in method" and sent them back to pick another
 *     button. It isn't and they don't: typing the address gets them a code and
 *     lands them in the same account.
 *   - `TypoSuggestion:`, and the domain-typo table in the form action below.
 *     Bouncing someone back to retype an address they have already typed is
 *     the same reroute in a different costume. A wrong address simply doesn't
 *     arrive, and Resend is one click away.
 *   - `RateLimited`, which has been dead since the action started forwarding a
 *     throttled user to the code screen rather than back here.
 *
 * What is left is the set a user can actually act on.
 */
function describeError(code?: string): string | null {
  if (!code) return null;
  switch (code) {
    case 'InvalidEmail':
      return "That doesn't look like a valid email address. Please check it and try again.";
    case 'EmailSendFailed':
    case 'Configuration':
      return "Couldn't send your sign-in code. Try Google or Apple, or contact support.";
    case 'AccessDenied':
      return 'Access denied. If you think this is a mistake, contact support.';
    default:
      return `Sign-in failed: ${code}`;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl || '/trips';
  if (session?.user) redirect(callbackUrl);

  const notice =
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
          maxWidth: 400,
          boxSizing: 'border-box',
          background: 'var(--tp-surface)',
          border: '1px solid var(--tp-neutral-800)',
          borderRadius: 'var(--tp-radius-md)',
          padding: '32px 28px 22px',
          color: 'var(--tp-text)',
          // No box-shadow. On a dark ground elevation is an edge; a soft
          // shadow under a #232532 card against #161826 is invisible anyway.
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.16em',
            color: 'var(--tp-accent-300)',
            marginBottom: 6,
          }}
        >
          FERAL TRAVELS
        </div>
        {/* "sign up" is in the h1 on purpose: a new user scans for it and
            leaves if it isn't there. It is also what lets the body copy stop
            explaining that the three buttons are one account. */}
        <h1
          style={{
            fontSize: 24,
            fontWeight: 500,
            lineHeight: 1.15,
            letterSpacing: '-0.01em',
            margin: 0,
            marginBottom: 8,
          }}
        >
          Sign in or sign up
        </h1>
        <p
          style={{
            fontSize: 13,
            fontWeight: 400,
            lineHeight: 1.55,
            color: 'var(--tp-neutral-400)',
            textWrap: 'pretty',
            margin: 0,
            marginBottom: 24,
          }}
        >
          Google, Apple or your email — any of them, any time. They all land in the same account,
          and there&#8217;s no password to remember.
        </p>

        {notice && (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '9px 12px',
              borderRadius: 'var(--tp-radius-sm)',
              background: 'var(--tp-neutral-900)',
              border: '1px solid var(--tp-neutral-700)',
              color: 'var(--tp-neutral-200)',
              fontSize: 12,
              lineHeight: 1.45,
              marginBottom: 16,
            }}
          >
            {/* One box for every tone. Whether something went wrong is carried
                by the words; a red box on a sign-in screen reads as "your
                account is in trouble" when the truth is usually a typo. */}
            <span style={{ flexShrink: 0, lineHeight: 0, color: 'var(--tp-accent-300)' }}>
              <InfoIcon />
            </span>
            <span>{notice}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Google */}
          <form
            action={async () => {
              'use server';
              await signIn('google', { redirectTo: callbackUrl });
            }}
          >
            <button type="submit" data-testid="login-google-button" className="auth-btn auth-btn-google">
              <GoogleMark />
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
              <button type="submit" data-testid="login-apple-button" className="auth-btn auth-btn-apple">
                <AppleMark />
                Continue with Apple
              </button>
            </form>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '20px 0 16px',
            color: 'var(--tp-subtle)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.12em',
          }}
        >
          {/* Each rule fades at its OUTER end, so the pair reads as one line
              passing behind the label rather than two stubs bolted to it. */}
          <div
            style={{
              flex: 1,
              height: 1,
              background: 'linear-gradient(to right, transparent, var(--tp-neutral-800))',
            }}
          />
          OR EMAIL
          <div
            style={{
              flex: 1,
              height: 1,
              background: 'linear-gradient(to left, transparent, var(--tp-neutral-800))',
            }}
          />
        </div>

        {/* Email / OTP */}
        <form
          action={async (formData: FormData) => {
            'use server';
            const email = String(formData.get('email') || '').trim();
            if (!email) return;

            // The browser's type="email" validation is client-side only and
            // trivially bypassed. This catches a malformed address before it
            // costs a Resend call. It does NOT try to second-guess the domain
            // — see the note on `describeError` above.
            const emailRe = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
            if (!emailRe.test(email)) {
              redirect(
                `/login?emailError=${encodeURIComponent('InvalidEmail')}&callbackUrl=${encodeURIComponent(callbackUrl)}`
              );
              return;
            }

            try {
              await sendOtpCode(email);
            } catch (err) {
              /**
               * Being throttled here is not a failed sign-in — it means a
               * code for this address is already in flight. Bouncing back to
               * this page with an error made the user re-enter an address
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
          {/*
            `autoComplete="email"` is the functional half of this screen. Without
            it neither a browser's saved addresses nor an iOS keychain entry is
            offered, so every returning user types their address out by hand on
            a phone. The other three attributes stop iOS from capitalising the
            first letter and red-underlining the domain.
          */}
          <input
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="auth-input"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button type="submit" className="auth-btn auth-btn-email">
            Email me a 6-digit code
          </button>
        </form>

        {/* Both Google's brand verification and Apple's App Review look for
            reachable legal links on the sign-in surface. Keeping them here
            rather than in a global footer means they sit on the one page a
            reviewer is guaranteed to see. */}
        <p
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--tp-neutral-800)',
            textAlign: 'center',
            fontSize: 11,
            fontWeight: 400,
            color: 'var(--tp-neutral-500)',
            marginBottom: 0,
          }}
        >
          <Link href="/privacy" className="auth-link">
            Privacy
          </Link>
          {' · '}
          <Link href="/terms" className="auth-link">
            Terms
          </Link>
        </p>
      </div>
    </div>
  );
}
