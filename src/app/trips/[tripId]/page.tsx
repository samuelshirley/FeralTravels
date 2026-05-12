import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { recalculateUserRemediationFlag } from '@/server/repos/remediationFlags';
import { getTripFull } from '@/server/repos/trips';
import { getChatPage } from '@/server/repos/chat';
import { getUnitsPref } from '@/server/repos/users';
import { getVehicleRemediationSnapshot } from '@/server/vehicleRemediation';
import { UnitsProvider } from '@/components/UnitsContext';
import VehicleRemediationOverlay from '@/components/VehicleRemediationOverlay';
import TripWorkspace from './TripWorkspace';

export const dynamic = 'force-dynamic';

interface Props {
  params: { tripId: string };
}

export default async function TripPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const tripId = parseInt(params.tripId, 10);
  if (Number.isNaN(tripId)) notFound();

  const trip = await getTripFull(tripId);
  if (!trip) notFound();

  // Owner OR template (read-only).
  const isOwner = trip.user_id === session.user.id;
  if (!isOwner && !trip.is_template) notFound();

  const userId = session.user.id as string;
  const unitsPref = await getUnitsPref(userId);

  // Gate: if the user has vehicles with missing required fields, show the
  // Penny remediation chat BEFORE loading the trip workspace.
  if (isOwner) {
    const needsRemediation = await recalculateUserRemediationFlag(userId);
    if (needsRemediation) {
      const snapshot = await getVehicleRemediationSnapshot(userId);
      if (snapshot.needs_remediation && !snapshot.done && snapshot.question) {
        return (
          <UnitsProvider initialUnits={unitsPref}>
            <VehicleRemediationOverlay initialSnapshot={snapshot} />
          </UnitsProvider>
        );
      }
    }
  }

  const admin = await isAdmin(session.user.email);
  const initialChat = await getChatPage({ tripId });

  return (
    <UnitsProvider initialUnits={unitsPref}>
      <TripWorkspace
        tripId={tripId}
        readonly={!isOwner}
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
        isAdmin={admin}
        initialChat={initialChat}
        serverOnboardingState={trip.onboarding_state}
      />
    </UnitsProvider>
  );
}
