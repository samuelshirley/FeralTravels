import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { breakerSnapshot, gateMixSince, topGatedAccounts } from '@/server/payments';
import { recentIpLimitHits } from '@/server/ipLimit';
import { lockedAccounts } from '@/server/repos/users';
import PennyLockdownBlock from '../PennyLockdownBlock';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The "Penny lockdown" tile's screen: breakers, the manual switch, who was refused. */
export default async function AdminPennyPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  /*
   * The live breaker reading, deliberately UNCACHED. The gate reads a
   * thirty-second cache because it runs on every request; this page is read by
   * one person, and showing them a value from before they threw the switch is
   * the exact failure the switch was moved out of the environment to avoid.
   * The four side panels keep the old dashboard's behaviour: a failed read is an
   * empty list, logged, because the meters above them are the part that matters.
   */
  const breakers = await breakerSnapshot();
  const [ipHits, gateMix, topGated, lockedOut] = await Promise.all([
    recentIpLimitHits(24).catch((err) => {
      console.error('[admin/penny] recentIpLimitHits failed', err);
      return [];
    }),
    gateMixSince(24).catch((err) => {
      console.error('[admin/penny] gateMixSince failed', err);
      return [];
    }),
    topGatedAccounts(24).catch((err) => {
      console.error('[admin/penny] topGatedAccounts failed', err);
      return [];
    }),
    lockedAccounts().catch((err) => {
      console.error('[admin/penny] lockedAccounts failed', err);
      return [];
    }),
  ]);

  return (
    <AdminShell user={session.user} title="Penny lockdown">
      <section className={styles.card}>
        <PennyLockdownBlock snapshot={breakers} ipHits={ipHits} gateMix={gateMix} topGated={topGated} lockedOut={lockedOut} />
      </section>
    </AdminShell>
  );
}
