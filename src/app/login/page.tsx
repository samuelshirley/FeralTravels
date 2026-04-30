import { redirect } from 'next/navigation';
import { auth, signIn } from '@/server/auth';

interface LoginPageProps {
  searchParams: { callbackUrl?: string; error?: string; emailError?: string };
}

// Auth.js v5 routes provider failures to /api/auth/error?error=<code>. Map
// the codes we actually see into copy users can act on instead of showing
// raw machine codes.
function describeError(code?: string): string | null {
  if (!code) return null;
  switch (code) {
    case 'OAuthAccountNotLinked':
      return 'This email is already tied to a different sign-in method. Use the Google button above if you usually sign in with Google, or open the magic link you requested—both should use the same account after linking.';
    case 'EmailSignin':
    case 'EmailSendFailed':
    case 'Configuration':
      return "Couldn't send the sign-in email. Try Google sign-in or contact support.";
    case 'AccessDenied':
      return 'Access denied. If you think this is a mistake, contact support.';
    case 'Verification':
      return 'That sign-in link has expired or already been used. Request a new one.';
    default:
      return `Sign-in failed: ${code}`;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl || '/trips';
  if (session?.user) redirect(callbackUrl);

  const errorMessage = describeError(searchParams.error)
    || (searchParams.emailError ? describeError(searchParams.emailError) : null);

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
        padding: 24,
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
          padding: 32,
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
          Sign in with Google or get a magic link by email. The same email always maps to one
          account—your saved vehicles (e.g. trip defaults) stay under that account regardless of
          which method you use.
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

        <form
          action={async (formData: FormData) => {
            'use server';
            const email = String(formData.get('email') || '').trim();
            if (!email) return;
            try {
              await signIn('resend', { email, redirectTo: callbackUrl });
            } catch (err) {
              // Auth.js intentionally throws a `redirect` error after a
              // successful sign-in start to perform the navigation; let
              // that bubble. Anything else is a real failure (Resend 403,
              // missing API key, etc.) — bounce back to /login with a
              // friendly error code we map in describeError().
              if (err && typeof err === 'object' && 'digest' in err && String((err as { digest?: string }).digest).startsWith('NEXT_REDIRECT')) {
                throw err;
              }
              const message = err instanceof Error ? err.message : String(err);
              const code = message.startsWith('EmailSendFailed') ? 'EmailSendFailed' : 'EmailSignin';
              console.error('[login] email sign-in failed:', message);
              redirect(`/login?emailError=${encodeURIComponent(code)}&callbackUrl=${encodeURIComponent(callbackUrl)}`);
            }
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
            Email me a sign-in link
          </button>
        </form>
      </div>
    </div>
  );
}
