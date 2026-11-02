import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from '../AdminShell';
import { paywallEnabled } from '@/server/payments';
import PromoCodeBlock from '../PromoCodeBlock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The "Promo codes" tile's screen: mint form and the issued-codes table. */
export default async function AdminPromoPage() {
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const paywallOn = await paywallEnabled();
  return (
    <AdminShell user={session.user} title="Promo codes">
      <PromoCodeBlock paywallOn={paywallOn} />
    </AdminShell>
  );
}
