import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { getResendCooldownRemainingMs, retryAfterSeconds } from '@/server/auth/otp';
import { VerifyForm } from './verify-form';

interface VerifyPageProps {
  searchParams: {
    email?: string;
    callbackUrl?: string;
    error?: string;
    resent?: string;
    retryAfter?: string;
  };
}

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const session = await auth();
  const callbackUrl = searchParams.callbackUrl || '/trips';

  // Already signed in — send them on their way.
  if (session?.user) redirect(callbackUrl);

  // If no email in the URL, bounce back to login.
  const email = searchParams.email?.trim();
  if (!email) redirect('/login');

  /**
   * Seconds until Resend is live again, read from the throttle on every
   * render rather than assumed. The page is reached three ways — straight
   * from /login, from a rejected resend, from a wrong code — and only one of
   * them carries a `retryAfter`, so the URL value is a hint and the database
   * is the answer. Landing here from /login is the common case and is exactly
   * where the old UI was worst: a code had just been sent, so Resend was
   * already dead, and the page offered it anyway with no hint of that.
   */
  const urlHint = Number(searchParams.retryAfter);
  const remainingMs = await getResendCooldownRemainingMs(email);
  const resendInSeconds = Math.max(
    remainingMs > 0 ? retryAfterSeconds(remainingMs) : 0,
    Number.isFinite(urlHint) && urlHint > 0 ? Math.floor(urlHint) : 0
  );

  return (
    <div
      style={{
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
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, marginBottom: 20 }}>
          Enter your code
        </h1>

        <VerifyForm
          email={email}
          callbackUrl={callbackUrl}
          error={searchParams.error}
          resent={searchParams.resent === '1'}
          resendInSeconds={resendInSeconds}
        />
      </div>
    </div>
  );
}
