import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAccountVerdict } from '@/server/payments';
import { listTripsForUser } from '@/server/repos/trips';
import { getUnitsPref, getUserTimezone } from '@/server/repos/users';
import { todayISOInZone } from '@/lib/dates';
import { isTripCompleted } from '@/lib/tripCompletion';
import AppNavbar from '@/components/AppNavbar';

import { UnitsProvider } from '@/components/UnitsContext';
import ViewportHintFromCookie from '@/components/ViewportHintFromCookie';
import AnnouncementModal from '@/components/AnnouncementModal';
import EntitlementNotice from '@/components/EntitlementNotice';
import NewTripButton from './NewTripButton';
import TripsList from './TripsList';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';

export default async function TripsPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id as string;
  const [allTrips, admin, unitsPref, timezone, verdict] = await Promise.all([
    listTripsForUser(userId),
    isAdmin(session.user.email),
    getUnitsPref(userId),
    // "Today" for the completed check. The server runs in UTC, so it has to be
    // the driver's zone or a trip ending today reads as finished from ~16:00
    // west of Greenwich. One resolution, handed to every card.
    getUserTimezone(userId),
    // The one entitlement question, asked once per render on the server. The
    // client is never the authority here — hiding the button is a courtesy,
    // and `POST /api/trips` refuses on its own regardless of what the page
    // chose to draw.
    getAccountVerdict(userId),
  ]);

  const today = todayISOInZone(timezone);
  const myTrips = allTrips.filter((t) => t.user_id === userId);

  // No auto-create when the user has zero trips. New users (and anyone who
  // just deleted their last trip) land on this list with the emphasized
  // "+ New trip" button. Clicking it creates the trip (no name prompt — Penny
  // names it after building the route) and opens the workspace, where Penny's
  // onboarding chat starts — see NewTripButton + server/onboarding.
  const templates = allTrips.filter((t) => t.is_template && t.user_id !== userId);

  return (
    <ViewportHintFromCookie>
    <UnitsProvider initialUnits={unitsPref}>
      <AnnouncementModal />
      <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <AppNavbar
          user={{
            name: session.user.name,
            email: session.user.email,
            image: session.user.image,
          }}
          isAdmin={admin}
        />

        <main className="page-main">
          <div className="page-header">
            <div style={{ minWidth: 0 }}>
              <div className="page-eyebrow">YOUR TRIPS</div>
              <h1 className="page-title">Trips</h1>
            </div>
            {/*
              Creating a trip is the first thing that spends money, so an
              unentitled account does not get the button at all. Disabled-and-
              still-there was the other option and it is worse: it invites a
              click that can only fail, and the notice below already says why.
            */}
            {verdict.entitled && <NewTripButton emphasizeWhenNoTrips={myTrips.length === 0} />}
          </div>

          {/*
            The block is an overlay now, not a card in the flow — it covers this
            page rather than sitting above a still-usable list. `pennyHref`
            points at the most recent trip's chat (the list arrives
            most-recently-active first), which is where the same block is a
            message from Penny that answers back. An account with no trip has no
            chat to be sent to: chat_history is trip-scoped.
          */}
          {verdict.blockReason && (
            <EntitlementNotice
              blockReason={verdict.blockReason}
              pennyHref={myTrips[0] ? `/trips/${myTrips[0].id}?chat=1` : null}
            />
          )}

          {/*
            `refunded` and `revoked` are the only states that close the trips
            themselves. Every other block leaves them readable — reading costs
            nothing and stranding someone mid-road-trip with a plan they can no
            longer see would be gratuitous.
          */}
          {verdict.canViewExistingTrips && (
            <TripsList
              myTrips={myTrips.map(
                ({ id, name, start_date, end_date, status, last_day_iso }) => ({
                  id,
                  name,
                  start_date,
                  end_date,
                  status,
                  completed: isTripCompleted(last_day_iso, today),
                }),
              )}
              templates={templates.map(({ id, name, start_date, end_date, status }) => ({
                id,
                name,
                start_date,
                end_date,
                status,
                // Demo templates are dated in the past and are never "over" —
                // they are something to clone, not a trip anyone drove.
                completed: false,
              }))}
              canDeleteTemplates={admin}
            />
          )}
        </main>

      </div>
    </UnitsProvider>
    </ViewportHintFromCookie>
  );
}
