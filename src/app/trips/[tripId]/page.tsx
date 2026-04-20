import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getTripFull } from '@/server/repos/trips';
import { getChatPage } from '@/server/repos/chat';
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
  // Ship the most-recent page of chat with the HTML so the chat panel isn't
  // empty on hard refresh. Older messages are loaded lazily via GET /api/chat.
  const initialChat = await getChatPage({ tripId });

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
      initialChat={initialChat}
    />
  );
}
