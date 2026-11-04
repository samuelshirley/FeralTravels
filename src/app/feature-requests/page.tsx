import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listFeatureRequestsForUser } from '@/server/repos/featureRequests';
import AppNavbar from '@/components/AppNavbar';
import FeatureRequestsBoard from '@/components/FeatureRequestsBoard';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';

/**
 * Feature requests, web. The same screen as iOS (mobile/app/feature-requests.tsx),
 * reached the same way: the account menu's "Feature requests" row.
 * accountMenuParity.test.ts keeps the two menus' rows in step.
 */
export default async function FeatureRequestsPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  const admin = await isAdmin(session.user.email);
  const rows = await listFeatureRequestsForUser(session.user.id as string);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={{ name: session.user.name, email: session.user.email, image: session.user.image }}
        isAdmin={admin}
      />
      <main
        style={{
          flex: 1,
          maxWidth: 640,
          width: '100%',
          margin: '0 auto',
          padding: '24px 14px 80px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500 }}>Feature requests</h1>
          {admin ? (
            <Link href="/admin/feature-requests" style={{ fontSize: 12, fontWeight: 600, color: 'var(--tp-primary)' }}>
              Manage →
            </Link>
          ) : null}
        </div>
        <FeatureRequestsBoard initialRows={rows} />
      </main>
    </div>
  );
}
