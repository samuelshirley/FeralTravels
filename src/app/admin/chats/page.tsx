import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getRecentChatActivity } from '@/server/repos/admin';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import ChatsTable from './ChatsTable';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIMIT = 100;

/** The "Recent chat" tile's screen. */
export default async function AdminChatsPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await getRecentChatActivity(LIMIT);
  return (
    <AdminShell user={session.user} title="Recent chat" count={`newest ${rows.length}`}>
      <section className={styles.card}>
        <ChatsTable rows={rows} now={new Date()} />
      </section>
    </AdminShell>
  );
}
