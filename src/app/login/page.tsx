import { redirect } from 'next/navigation';
import { auth, signIn } from '@/server/auth';
import { sendOtpCode } from '@/server/auth/otp';
import {
  authTestBackdoorEmailNormalized,
  authTestBackdoorRequiresToken,
  isAuthTestBackdoorConfigured,
} from '@/server/auth/test-backdoor';

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
      return 'A code was already sent recently — please wait 60 seconds before requesting another.';
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

  const testBackdoorOn = isAuthTestBackdoorConfigured();
  const testBackdoorEmail = authTestBackdoorEmailNormalized();
  const testBackdoorWantToken = authTestBackdoorRequiresToken();

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
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, marginBottom: 4 }}>Sign in</h1>
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
        </p>

        {testBackdoorOn && testBackdoorEmail && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 'var(--tp-radius-sm)',
              background: 'var(--tp-primary-muted)',
              border: '1px solid rgba(78, 122, 176, 0.35)',
              color: 'var(--tp-primary)',
              fontSize: 12,
              marginBottom: 16,
              lineHeight: 1.45,
            }}
          >
            <strong>Test sign-in</strong> — Use <code style={{ fontSize: 11 }}>{testBackdoorEmail}</code> and
            submit &quot;Email me a code&quot; for an <strong>instant session</strong> (no email). Remove{' '}
            <code style={{ fontSize: 11 }}>AUTH_TEST_BACKDOOR</code> before a public launch.
          </div>
        )}

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

            // Test backdoor shortcut: bypass OTP for the configured test email.
            const backdoorEmail = authTestBackdoorEmailNormalized();
            if (backdoorEmail && email.toLowerCase() === backdoorEmail) {
              const token = String(formData.get('test_token') || '');
              try {
                await signIn('auth-test-backdoor', {
                  email,
                  token,
                  redirectTo: callbackUrl,
                });
              } catch (err) {
                if (
                  err &&
                  typeof err === 'object' &&
                  'digest' in err &&
                  String((err as { digest?: string }).digest).startsWith('NEXT_REDIRECT')
                ) {
                  throw err;
                }
                const message = err instanceof Error ? err.message : String(err);
                console.error('[login] test backdoor sign-in failed:', message);
                redirect(
                  `/login?emailError=${encodeURIComponent('AccessDenied')}&callbackUrl=${encodeURIComponent(callbackUrl)}`
                );
              }
              return;
            }

            // Send OTP code and redirect to the verify screen.
            try {
              await sendOtpCode(email);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const code = message === 'RateLimited'
                ? 'RateLimited'
                : message.startsWith('EmailSendFailed')
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
            placeholder={testBackdoorEmail ? testBackdoorEmail : 'you@example.com'}
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
          {testBackdoorOn && testBackdoorWantToken && (
            <input
              name="test_token"
              type="password"
              autoComplete="off"
              placeholder="Test backdoor token (AUTH_TEST_BACKDOOR_SECRET)"
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
          )}
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
            {testBackdoorOn && testBackdoorEmail ? ' / test instant sign-in' : ''}
          </button>
        </form>
      </div>
    </div>
  );
}
