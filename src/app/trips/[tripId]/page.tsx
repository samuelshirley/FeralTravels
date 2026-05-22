import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getChatPage } from '@/server/repos/chat';
import { getTripFull } from '@/server/repos/trips';
import { getUnitsPref } from '@/server/repos/users';
import { getVehicleRemediationSnapshot } from '@/server/vehicleRemediation';
import { UnitsProvider } from '@/components/UnitsContext';
import TripWorkspace from './TripWorkspace';

export const dynamic = 'force-dynamic';

interface Props {
  params: { tripId: string };
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function TripPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const tripId = params.tripId;

  const trip = await getTripFull(tripId);
  if (!trip) notFound();

  // Owner OR template (read-only).
  const isOwner = trip.user_id === session.user.id;
  if (!isOwner && !trip.is_template) notFound();

  const userId = session.user.id as string;
  const unitsPref = await getUnitsPref(userId);

  // Check if the user's vehicles have missing required fields — pass the flag
  // to TripWorkspace which shows remediation questions in the chat composer.
  let needsVehicleRemediation = false;
  if (isOwner) {
    const remediationSnapshot = await getVehicleRemediationSnapshot(userId);
    needsVehicleRemediation = remediationSnapshot.needs_remediation && !remediationSnapshot.done;
  }

  const admin = await isAdmin(session.user.email);
  const initialChat = await getChatPage({ tripId });

  return (
    <UnitsProvider initialUnits={unitsPref}>
      <TripWorkspace
        tripId={tripId}
        serverTrip={{
          name: trip.name,
          vehicle_id: trip.vehicle_id ?? null,
        }}
        readonly={!isOwner}
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
        isAdmin={admin}
        initialChat={initialChat}
        serverOnboardingState={trip.onboarding_state}
        needsVehicleRemediation={needsVehicleRemediation}
        replanFromOffRoute={searchParams.replan === 'true'}
      />
    </UnitsProvider>
  );
}
