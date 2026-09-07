import { notFound, redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAccountVerdict } from '@/server/payments';
import { getChatPage } from '@/server/repos/chat';
import { getTripFull } from '@/server/repos/trips';
import { getPoisForTrip } from '@/server/repos/pois';
import { getUnitsPref } from '@/server/repos/users';
import { UnitsProvider } from '@/components/UnitsContext';
import ViewportHintFromCookie from '@/components/ViewportHintFromCookie';
import TripWorkspace from './TripWorkspace';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';

interface Props {
  params: { tripId: string };
  searchParams: { [key: string]: string | string[] | undefined };
}

export default async function TripPage({ params, searchParams }: Props) {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
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
  const initialPois = await getPoisForTrip(tripId);

  return (
    <ViewportHintFromCookie>
    <UnitsProvider initialUnits={unitsPref}>
      <TripWorkspace
        tripId={tripId}
        serverTrip={{
          name: trip.name,
          vehicle_id: trip.vehicle_id ?? null,
        }}
        // The whole trip, so the server renders the real workspace tree and
        // the client hydrates it — no second fetch, no second spinner. With
        // the viewport hint this is also what makes a phone's reload paint
        // the phone's tree first.
        initialTrip={trip}
        initialPois={initialPois}
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
        // `?chat=1` — the paywall overlay's "Talk to Penny" link. On a phone
        // this page opens on the itinerary tab, which is not where someone who
        // just clicked her name wants to land.
        openChatOnMount={searchParams.chat === '1'}
        // The same verdict that decided the redirect above, handed to the
        // workspace so the map and the itinerary render already covered. This
        // is the `EntitlementNotice` argument applied to the trip page: a
        // client that fetched its own entitlement would paint a working
        // itinerary first and take it away a moment later, which briefly lies
        // about what the account can do — and on this page the lie is
        // clickable. Null on a template someone else owns: it is not their
        // bill, and ChatPanel skips its paywall message there for the same
        // reason.
        blockReason={isOwner ? verdict.blockReason : null}
      />
    </UnitsProvider>
    </ViewportHintFromCookie>
  );
}
