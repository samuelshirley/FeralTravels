import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { getUnitsPref } from '@/server/repos/users';
import { getVehicleRemediationSnapshot } from '@/server/vehicleRemediation';
import { UnitsProvider } from '@/components/UnitsContext';
import VehicleRemediationOverlay from '@/components/VehicleRemediationOverlay';

export const dynamic = 'force-dynamic';

function safeInternalReturnPath(raw: string | string[] | undefined): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\n') || v.includes('\r'))
    return null;
  return v;
}

interface Props {
  searchParams?: { returnTo?: string | string[] };
}

export default async function VehicleSetupPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id as string;
  const unitsPref = await getUnitsPref(userId);
  const returnToRaw = searchParams?.returnTo;
  const returnTo = Array.isArray(returnToRaw)
    ? safeInternalReturnPath(returnToRaw[0])
    : safeInternalReturnPath(returnToRaw);

  const snapshot = await getVehicleRemediationSnapshot(userId);
  if (!snapshot.needs_remediation || snapshot.done) {
    redirect(returnTo ?? '/trips');
  }

  return (
    <UnitsProvider initialUnits={unitsPref}>
      <VehicleRemediationOverlay initialSnapshot={snapshot} returnTo={returnTo ?? '/trips'} />
    </UnitsProvider>
  );
}
