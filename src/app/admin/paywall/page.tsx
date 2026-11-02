import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { paywallEnabled } from '@/server/payments';
import PaywallSwitch from '../PaywallSwitch';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The "Paywall" tile's screen: the deployment-wide switch, a database row. */
export default async function AdminPaywallPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const on = await paywallEnabled();
  return (
    <AdminShell
      user={session.user}
      title="Paywall"
      subtitle="Off: account states keep being computed but nobody is walled. Per-account overrides are on each user's page."
    >
      <section className={styles.card}>
        <PaywallSwitch on={on} />
      </section>
    </AdminShell>
  );
}
