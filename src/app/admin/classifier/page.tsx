import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { countJevOverrides, getJevCompareStats, getJevStats, globalJevMode, jevConfigView, JEV_MIN_MARGIN } from '@/server/repos/jev';
import JevSwitch from '../JevSwitch';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The "Message classifier" tile's screen: the Jev switch and its week. */
export default async function AdminClassifierPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  /*
   * A failed stats or override read renders as "could not read" rather than as
   * zeros — zero settled is a real, and very different, answer. The mode read
   * itself fails to OFF, like the gate's.
   */
  const [mode, stats, compare, overrides] = await Promise.all([
    globalJevMode(),
    getJevStats(7).catch((err) => {
      console.error('[admin] getJevStats failed', err);
      return null;
    }),
    getJevCompareStats(7).catch((err) => {
      console.error('[admin] getJevCompareStats failed', err);
      return null;
    }),
    countJevOverrides().catch((err) => {
      console.error('[admin] countJevOverrides failed', err);
      return null;
    }),
  ]);

  return (
    <AdminShell user={session.user} title="Message classifier">
      <section className={styles.card}>
        <JevSwitch mode={mode} config={jevConfigView()} stats={stats} compare={compare} overrides={overrides} minMargin={JEV_MIN_MARGIN} />
      </section>
    </AdminShell>
  );
}
