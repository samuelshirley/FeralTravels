import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getProviderTotals } from '@/server/repos/admin';
import { getGoogleBillableThisMonth } from '@/server/repos/usage';
import { readAnthropicSpend, readGoogleSpend } from '@/server/providerSpend';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { settle } from '../tiles';
import CostView from './CostView';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The Cost section's detail screen ("Projected / mo", "Cost breakdown"). */
export default async function AdminCostPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const [anthropic, google, estimate] = await Promise.all([
    readAnthropicSpend(),
    readGoogleSpend(),
    settle(
      'internal estimate',
      Promise.all([getProviderTotals(24 * 7), getGoogleBillableThisMonth()]).then(([rows, googleMonth]) => ({
        rows: rows.map((r) => ({ provider: r.provider, requests: Number(r.requests), microcents: Number(r.microcents) })),
        googleMonth,
      }))
    ),
  ]);

  return (
    <AdminShell user={session.user} title="Cost">
      <CostView anthropic={anthropic} google={google} estimate={estimate} />
    </AdminShell>
  );
}
