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
      return 'This email is already linked to another sign-in method.';
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
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#0D0D0D',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 32,
          color: '#fff',
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.15em',
            color: 'rgba(255,255,255,0.3)',
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 6,
          }}
        >
          TRIP PLANNER
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, marginBottom: 4 }}>Sign in</h1>
        <p
          style={{
            fontSize: 13,
            color: 'rgba(255,255,255,0.5)',
            margin: 0,
            marginBottom: 24,
            lineHeight: 1.5,
          }}
        >
          Sign in with Google or get a magic link by email.
        </p>

        {errorMessage && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(232,146,124,0.12)',
              border: '1px solid rgba(232,146,124,0.3)',
              color: '#E8927C',
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
              background: '#fff',
              color: '#000',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
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
            color: 'rgba(255,255,255,0.3)',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.1em',
          }}
        >
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
          OR EMAIL
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
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
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8,
              color: '#fff',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            type="submit"
            style={{
              padding: '10px 16px',
              background: '#7CB5E8',
              color: '#000',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Email me a sign-in link
          </button>
        </form>

        <p
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.3)',
            marginTop: 20,
            lineHeight: 1.5,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Each user owns their own trips and vehicles. The Iberia/Nordkapp demo trip is visible on
          the trips list and can be cloned to your account.
        </p>
      </div>
    </div>
  );
}
