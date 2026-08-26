import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAccountVerdict } from '@/server/payments';
import { listTripsForUser } from '@/server/repos/trips';
import { getUnitsPref } from '@/server/repos/users';
import AppNavbar from '@/components/AppNavbar';

import { UnitsProvider } from '@/components/UnitsContext';
import AnnouncementModal from '@/components/AnnouncementModal';
import EntitlementNotice from '@/components/EntitlementNotice';
import NewTripButton from './NewTripButton';
import TripsList from './TripsList';

export const dynamic = 'force-dynamic';

export default async function TripsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id as string;
  const [allTrips, admin, unitsPref, verdict] = await Promise.all([
    listTripsForUser(userId),
    isAdmin(session.user.email),
    getUnitsPref(userId),
    // The one entitlement question, asked once per render on the server. The
    // client is never the authority here — hiding the button is a courtesy,
    // and `POST /api/trips` refuses on its own regardless of what the page
    // chose to draw.
    getAccountVerdict(userId),
  ]);

  const myTrips = allTrips.filter((t) => t.user_id === userId);

  // No auto-create when the user has zero trips. New users (and anyone who
  // just deleted their last trip) land on this list with the emphasized
  // "+ New trip" button. Clicking it creates the trip (no name prompt — Penny
  // names it after building the route) and opens the workspace, where Penny's
  // onboarding chat starts — see NewTripButton + server/onboarding.
  const templates = allTrips.filter((t) => t.is_template && t.user_id !== userId);

  return (
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

          {verdict.blockReason && <EntitlementNotice blockReason={verdict.blockReason} />}

          {/*
            `refunded` and `revoked` are the only states that close the trips
            themselves. Every other block leaves them readable — reading costs
            nothing and stranding someone mid-road-trip with a plan they can no
            longer see would be gratuitous.
          */}
          {verdict.canViewExistingTrips && (
            <TripsList
              myTrips={myTrips.map(({ id, name, start_date, end_date, status }) => ({
                id,
                name,
                start_date,
                end_date,
                status,
              }))}
              templates={templates.map(({ id, name, start_date, end_date, status }) => ({
                id,
                name,
                start_date,
                end_date,
                status,
              }))}
              canDeleteTemplates={admin}
            />
          )}
        </main>

      </div>
    </UnitsProvider>
  );
}
