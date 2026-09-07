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

  /*
   * The throttle read CANNOT be allowed to take this page down. It decides
   * how a countdown renders; the page is the only way into the product. An
   * unguarded await here means any failure of that one query — the table
   * missing because a migration has not run yet, a connection blip — turns
   * the whole sign-in screen into a 500 and nobody gets in at all. Found by
   * loading this page against a database without migration 0030.
   *
   * On failure we fall back to the URL hint, which is the same number the
   * redirect that sent the user here already computed. The server remains the
   * authority regardless: a press that arrives too early is refused by
   * `sendOtpCode`, not by this countdown.
   */
  let remainingMs = 0;
  try {
    remainingMs = await getResendCooldownRemainingMs(email);
  } catch (err) {
    console.error('[verify] could not read the resend throttle:', err);
  }

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
          maxWidth: 400,
          boxSizing: 'border-box',
          background: 'var(--tp-surface)',
          border: '1px solid var(--tp-neutral-800)',
          borderRadius: 'var(--tp-radius-md)',
          padding: '32px 28px 22px',
          color: 'var(--tp-text)',
          // No box-shadow — on a dark ground elevation is an edge.
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
          Check your email
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
