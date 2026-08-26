import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTestAccounts } from '@/server/payments/testAccounts';
import { testPurchasesArmed } from '@/server/payments/testPurchase';
import AppNavbar from '@/components/AppNavbar';
import TestUsersClient from './TestUsersClient';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

export default async function AdminTestUsersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Silent redirect, same as every other admin page — no error page, no hint
  // to a signed-in non-admin that /admin exists at all.
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  // Read the switch HERE rather than letting the API throw and rendering the
  // stack: "SUBSCRIPTION_TESTING is not set" is a configuration fact, not a
  // failure, and an admin who sees it needs the variable name, not a 500.
  const armed = testPurchasesArmed();

  // Only queried when armed. The listing itself is harmless, but a page that
  // says "this feature is off" and then prints its data underneath is lying
  // about which state it is in.
  const accounts = armed ? await listTestAccounts() : [];

  return (
    <div className={styles.wrapper}>
      <AppNavbar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
        isAdmin
      />

      <main className={styles.main}>
        <div style={{ marginBottom: 24 }}>
          <Link
            href="/admin"
            style={{
              fontSize: 12,
              color: 'var(--tp-primary)',
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            &larr; Admin
          </Link>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 0' }}>Test users</h1>
          <p
            style={{
              fontSize: 13,
              color: 'var(--tp-muted)',
              margin: '4px 0 0',
              maxWidth: '78ch',
              lineHeight: 1.5,
            }}
          >
            Disposable accounts for walking the paywall. Pick a state, copy the sign-in
            link into an incognito window, type the code — signed in as that user in about
            ten seconds, with your own session untouched.
          </p>
        </div>

        {armed ? (
          <TestUsersClient
            initialAccounts={accounts.map((a) => ({
              id: a.id,
              email: a.email,
              createdAt: a.createdAt.toISOString(),
              subscriptionStatus: a.subscriptionStatus,
              spendMicrocents: a.spendMicrocents,
            }))}
          />
        ) : (
          <section style={{ ...card, maxWidth: '80ch' }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>
              Test accounts are switched off in this environment
            </h2>
            <p
              style={{
                fontSize: 13,
                color: 'var(--tp-muted)',
                lineHeight: 1.6,
                margin: '0 0 10px',
              }}
            >
              Everything on this page needs{' '}
              <code style={{ fontSize: 12 }}>SUBSCRIPTION_TESTING=1</code>. It defaults to
              off, and the server refuses to create, age, reset or delete an account
              without it. Set it in this environment&apos;s variables and reload.
            </p>
            <p style={{ fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.6, margin: 0 }}>
              It should stay unset in production once real purchases are live. The
              accounts this page makes carry <code style={{ fontSize: 12 }}>source: &apos;fake&apos;</code>{' '}
              subscriptions that were never paid for, and the switch is how they stop
              being possible without a deploy.
            </p>
          </section>
        )}

        <p
          style={{
            fontSize: 11,
            color: 'var(--tp-subtle)',
            marginTop: 20,
            lineHeight: 1.6,
            maxWidth: '80ch',
          }}
        >
          Addresses are always{' '}
          <code style={{ fontSize: 10 }}>sam+trial-…@feraltravels.com</code> — the pattern
          is hardcoded in <code style={{ fontSize: 10 }}>payments/testPurchase.ts</code>{' '}
          where no environment variable can widen it, and the server refuses every address
          outside it.
        </p>
      </main>
    </div>
  );
}
