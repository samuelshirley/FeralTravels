import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAccountVerdict } from '@/server/payments';
import { getChatPage } from '@/server/repos/chat';
import { getTripFull } from '@/server/repos/trips';
import { getUnitsPref } from '@/server/repos/users';
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

  // `refunded` and `revoked` are the two states that close existing trips as
  // well as planning, so a bookmarked trip URL must not be the way around the
  // notice on /trips. Every other block leaves reading alone — it costs no
  // Anthropic call and stranding a driver mid-trip would be gratuitous.
  // Redirect rather than notFound(): /trips is where the explanation and the
  // support address are.
  const verdict = await getAccountVerdict(userId);
  if (!verdict.canViewExistingTrips) redirect('/trips');

  const unitsPref = await getUnitsPref(userId);

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
        replanFromOffRoute={searchParams.replan === 'true'}
      />
    </UnitsProvider>
  );
}
