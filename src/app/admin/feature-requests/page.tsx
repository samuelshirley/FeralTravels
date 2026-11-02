import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listFeatureRequestsForAdmin } from '@/server/repos/featureRequests';
import AppNavbar from '@/components/AppNavbar';
import FeatureRequestsClient from './FeatureRequestsClient';
import styles from '../admin.module.css';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /admin/feature-requests — write the requests the iOS app lists, set their
 * status, reply (shown in the app), and delete them. Linked from the stat card
 * on /admin.
 */
export default async function AdminFeatureRequestsPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await listFeatureRequestsForAdmin();

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
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ marginBottom: 20 }}>
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
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 0' }}>Feature requests</h1>
          </div>
          <FeatureRequestsClient initialRows={rows} />
        </div>
      </main>
    </div>
  );
}
