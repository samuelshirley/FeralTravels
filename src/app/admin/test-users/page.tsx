import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import Link from 'next/link';
import { paywallEnabled } from '@/server/payments';
import { testAccountsAvailable } from '@/server/payments/testAccountGate';
import { isProductionEnvironment } from '@/server/productionGuard';
import TestUserBlock from '../TestUserBlock';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The "Test users" tile's screen. In production the generator is NOT offered
 * (decision E13: it writes `source: 'fake'` subscriptions and rewrites
 * users.created_at, and refuses to load there), but the screen still renders and
 * says where to go instead. Elsewhere it is off without SUBSCRIPTION_TESTING=1.
 */
export default async function AdminTestUsersPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const production = isProductionEnvironment();
  const paywallOn = production ? false : await paywallEnabled();
  return (
    <AdminShell user={session.user} title="Test users">
      <section className={styles.card} data-testid="admin-test-users">
        {production ? (
          <div data-testid="admin-test-users-production" className={styles.subtle}>
            <p>Aged test accounts can&apos;t be generated against the production database (decision E13).</p>
            <ul>
              <li>
                To walk a real wall here, open the account from{' '}
                <Link href="/admin/users" className={styles.seeAllLink}>
                  Users
                </Link>{' '}
                and use <strong>Force the paywall on this account</strong>.
              </li>
              <li>
                To generate an aged account, use a preview deployment with <code>SUBSCRIPTION_TESTING=1</code>.
              </li>
            </ul>
          </div>
        ) : (
          <>
            <p className={styles.subtle}>
              Disposable accounts for walking the paywall. Addresses are always <code>sam+trial-…@feraltravels.com</code> — the
              pattern is hardcoded where no environment variable can widen it, and every action refuses anything outside it.
            </p>
            <TestUserBlock armed={testAccountsAvailable()} paywallOn={paywallOn} />
          </>
        )}
      </section>
    </AdminShell>
  );
}
