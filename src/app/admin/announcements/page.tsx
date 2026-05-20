import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listAnnouncements } from '@/server/repos/announcements';
import AppNavbar from '@/components/AppNavbar';
import AnnouncementsClient from './AnnouncementsClient';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminAnnouncementsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await listAnnouncements();

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
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 0' }}>
            Announcements
          </h1>
          <p style={{ fontSize: 13, color: 'var(--tp-muted)', margin: '4px 0 0' }}>
            Ship one-time popups to all users. Active announcements show once per user.
          </p>
        </div>

        <AnnouncementsClient
          initialRows={rows.map((r) => ({
            ...r,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
          }))}
        />
      </main>
    </div>
  );
}
