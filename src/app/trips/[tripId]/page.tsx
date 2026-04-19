import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getTripFull } from '@/server/repos/trips';
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

  const admin = await isAdmin(session.user.email);

  return (
    <TripWorkspace
      tripId={tripId}
      readonly={!isOwner}
      user={{
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      }}
      isAdmin={admin}
    />
  );
}
