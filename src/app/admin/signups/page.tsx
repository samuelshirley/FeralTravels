import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listNewSignups } from '@/server/repos/admin';
import { getAccountVerdict } from '@/server/payments';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { settle } from '../tiles';
import SignupsTable, { type SignupRow } from './SignupsTable';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SIGNUP_WINDOWS = [
  { value: '24h', label: '24h', hours: 24 },
  { value: '7d', label: '7 days', hours: 24 * 7 },
  { value: '30d', label: '30 days', hours: 24 * 30 },
] as const;

/** The "New signups" tile's screen. */
export default async function AdminSignupsPage({ searchParams }: { searchParams: { window?: string } }) {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const win = SIGNUP_WINDOWS.find((w) => w.value === searchParams.window) ?? SIGNUP_WINDOWS[1];
  const { rows, hiddenInternal } = await listNewSignups(win.hours, 200);

  // The entitlement verdict comes from the payments module, the one place that
  // may decide it — the same call the user's own detail page makes.
  const withVerdicts: SignupRow[] = await Promise.all(
    rows.map(async (r) => {
      const v = await settle(`verdict ${r.id}`, getAccountVerdict(r.id));
      return {
        ...r,
        entitlement: v.ok
          ? { ok: true as const, state: v.value.state, entitled: v.value.entitled, enforced: v.value.enforced, trialEndsAt: v.value.trialEndsAt }
          : { ok: false as const, error: v.error },
      };
    })
  );

  return (
    <AdminShell
      user={session.user}
      title="New signups"
      count={`${rows.length} in ${win.label}`}
      subtitle={hiddenInternal > 0 ? `${hiddenInternal} internal account(s) in this window not shown.` : undefined}
    >
      <nav className={styles.pills} aria-label="Window">
        {SIGNUP_WINDOWS.map((w) => (
          <Link
            key={w.value}
            href={`/admin/signups?window=${w.value}`}
            className={w.value === win.value ? styles.pillActive : styles.pill}
            aria-current={w.value === win.value ? 'page' : undefined}
          >
            {w.label}
          </Link>
        ))}
      </nav>
      <section className={styles.card}>
        <SignupsTable rows={withVerdicts} now={new Date()} />
      </section>
    </AdminShell>
  );
}
