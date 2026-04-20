import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import AppNavbar from '@/components/AppNavbar';
import NewTripButton from './NewTripButton';
import TripsList from './TripsList';

export const dynamic = 'force-dynamic';

export default async function TripsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [allTrips, admin] = await Promise.all([
    listTripsForUser(session.user.id),
    isAdmin(session.user.email),
  ]);
  const myTrips = allTrips.filter((t) => t.user_id === session.user.id);
  const templates = allTrips.filter((t) => t.is_template && t.user_id !== session.user.id);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
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
          <NewTripButton />
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
  );
}
