import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import { getUnitsPref } from '@/server/repos/users';
import AppNavbar from '@/components/AppNavbar';

import { UnitsProvider } from '@/components/UnitsContext';
import AnnouncementModal from '@/components/AnnouncementModal';
import NewTripButton from './NewTripButton';
import TripsList from './TripsList';

export const dynamic = 'force-dynamic';

export default async function TripsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id as string;
  const [allTrips, admin, unitsPref] = await Promise.all([
    listTripsForUser(userId),
    isAdmin(session.user.email),
    getUnitsPref(userId),
  ]);

  const myTrips = allTrips.filter((t) => t.user_id === userId);

  // No auto-create when the user has zero trips. New users (and anyone who
  // just deleted their last trip) land on this list with the emphasized
  // "+ New trip" button. They name the trip there, then the workspace opens
  // and Penny's onboarding chat starts — see NewTripButton + server/onboarding.
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
            <NewTripButton
              existingNames={myTrips.map((t) => t.name)}
              emphasizeWhenNoTrips={myTrips.length === 0}
            />
          </div>

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
        </main>

      </div>
    </UnitsProvider>
  );
}
