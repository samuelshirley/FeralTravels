import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import { recalculateUserRemediationFlag } from '@/server/repos/remediationFlags';
import { getUnitsPref } from '@/server/repos/users';
import { getVehicleRemediationSnapshot } from '@/server/vehicleRemediation';
import AppNavbar from '@/components/AppNavbar';
import MobileFooter from '@/components/MobileFooter';
import { UnitsProvider } from '@/components/UnitsContext';
import VehicleRemediationOverlay from '@/components/VehicleRemediationOverlay';
import NewTripButton from './NewTripButton';
import TripsList from './TripsList';

export const dynamic = 'force-dynamic';

export default async function TripsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const userId = session.user.id as string;
  const [allTrips, admin, unitsPref, needsVehicleRemediation] = await Promise.all([
    listTripsForUser(userId),
    isAdmin(session.user.email),
    getUnitsPref(userId),
    recalculateUserRemediationFlag(userId),
  ]);

  // If user has vehicles with missing required fields, gate them through the
  // Penny remediation chat before showing trips. We prefetch the snapshot here
  // so the overlay renders instantly (no loading spinner for the first question).
  if (needsVehicleRemediation) {
    const snapshot = await getVehicleRemediationSnapshot(userId);
    if (snapshot.needs_remediation && !snapshot.done) {
      return (
        <UnitsProvider initialUnits={unitsPref}>
          <VehicleRemediationOverlay initialSnapshot={snapshot} />
        </UnitsProvider>
      );
    }
  }

  const myTrips = allTrips.filter((t) => t.user_id === userId);
  const templates = allTrips.filter((t) => t.is_template && t.user_id !== userId);

  return (
    <UnitsProvider initialUnits={unitsPref}>
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
            <NewTripButton existingNames={myTrips.map((t) => t.name)} />
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
        <MobileFooter active="list" />
      </div>
    </UnitsProvider>
  );
}
