import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import AppNavbar from '@/components/AppNavbar';
import NewTripButton from './NewTripButton';
import CloneTripButton from './CloneTripButton';
import TripCard from './TripCard';

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

        {myTrips.length === 0 && (
          <div
            style={{
              padding: 20,
              border: '1px dashed rgba(255,255,255,0.12)',
              borderRadius: 10,
              color: 'rgba(255,255,255,0.5)',
              fontSize: 14,
              marginBottom: 20,
              lineHeight: 1.5,
            }}
          >
            You don&apos;t have any trips yet. Create a new one above, or clone the demo trip below.
          </div>
        )}

        <div className="card-grid">
          {myTrips.map((trip) => (
            <TripCard
              key={trip.id}
              id={trip.id}
              name={trip.name}
              startDate={trip.start_date ?? null}
              endDate={trip.end_date ?? null}
              status={trip.status}
            />
          ))}
        </div>

        {templates.length > 0 && (
          <div style={{ marginTop: 32 }}>
            <div className="page-eyebrow" style={{ marginBottom: 10 }}>
              DEMO / TEMPLATES
            </div>
            <div className="card-grid">
              {templates.map((trip) => (
                <div
                  key={trip.id}
                  style={{
                    padding: 16,
                    background: 'rgba(124,181,232,0.05)',
                    border: '1px solid rgba(124,181,232,0.2)',
                    borderRadius: 10,
                  }}
                >
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: '#fff',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {trip.name}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.45)',
                      fontFamily: "'JetBrains Mono', monospace",
                      marginTop: 4,
                    }}
                  >
                    {[trip.start_date, trip.end_date].filter(Boolean).join(' → ') || 'No dates set'}
                  </div>
                  <div
                    className="mobile-wrap"
                    style={{ display: 'flex', gap: 8, marginTop: 12 }}
                  >
                    <Link
                      href={`/trips/${trip.id}`}
                      style={{
                        fontSize: 12,
                        color: '#7CB5E8',
                        textDecoration: 'none',
                        padding: '6px 12px',
                        borderRadius: 6,
                        border: '1px solid rgba(124,181,232,0.3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      View →
                    </Link>
                    <CloneTripButton tripId={trip.id} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
