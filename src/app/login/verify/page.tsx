import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { VerifyForm } from './verify-form';

interface VerifyPageProps {
  searchParams: {
    email?: string;
    callbackUrl?: string;
    error?: string;
    resent?: string;
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
        />
      </div>
    </div>
  );
}
