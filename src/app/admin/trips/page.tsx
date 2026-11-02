import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listAdminTrips } from '@/server/repos/admin';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import TripsTable from './TripsTable';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIMIT = 200;

/** The "Active trips" tile's screen. */
export default async function AdminTripsPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await listAdminTrips(LIMIT);
  return (
    <AdminShell
      user={session.user}
      title="Trips"
      count={rows.length === LIMIT ? `newest ${LIMIT}` : `${rows.length} total`}
      subtitle="Templates excluded. A trip opens its Penny conversation."
    >
      <section className={styles.card}>
        <TripsTable rows={rows} now={new Date()} />
      </section>
    </AdminShell>
  );
}
