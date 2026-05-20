import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import { getUnitsPref } from '@/server/repos/users';
import { getVehicleRemediationSnapshot } from '@/server/vehicleRemediation';
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

  // If user has vehicles with missing required fields, redirect them to their
  // most recent trip where the ChatPanel remediation form will collect the data.
  // No SSR overlay — avoids hydration mismatches on mobile.
  const remediationSnapshot = await getVehicleRemediationSnapshot(userId);
  if (remediationSnapshot.needs_remediation && !remediationSnapshot.done && myTrips.length > 0) {
    const latestTrip = [...myTrips].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
    redirect(`/trips/${latestTrip.id}`);
  }

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
