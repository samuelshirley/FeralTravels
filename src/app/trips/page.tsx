import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listTripsForUser } from '@/server/repos/trips';
import AppNavbar from '@/components/AppNavbar';
import NewTripButton from './NewTripButton';
import CloneTripButton from './CloneTripButton';

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

      <main
        style={{
          flex: 1,
          padding: '32px 24px',
          maxWidth: 980,
          margin: '0 auto',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 24,
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.15em',
                color: 'rgba(255,255,255,0.3)',
                fontFamily: "'JetBrains Mono', monospace",
                marginBottom: 4,
              }}
            >
              YOUR TRIPS
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Trips</h1>
          </div>
          <NewTripButton />
        </div>

        {myTrips.length === 0 && (
          <div
            style={{
              padding: 24,
              border: '1px dashed rgba(255,255,255,0.12)',
              borderRadius: 10,
              color: 'rgba(255,255,255,0.5)',
              fontSize: 14,
              marginBottom: 24,
            }}
          >
            You don&apos;t have any trips yet. Create a new one above, or clone the demo trip below.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {myTrips.map((trip) => (
            <Link
              key={trip.id}
              href={`/trips/${trip.id}`}
              style={{
                display: 'block',
                padding: 16,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10,
                color: '#fff',
                textDecoration: 'none',
                transition: 'background 120ms',
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 600 }}>{trip.name}</div>
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
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                status: {trip.status}
              </div>
            </Link>
          ))}
        </div>

        {templates.length > 0 && (
          <div style={{ marginTop: 36 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.15em',
                color: 'rgba(255,255,255,0.3)',
                fontFamily: "'JetBrains Mono', monospace",
                marginBottom: 10,
              }}
            >
              DEMO / TEMPLATES
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
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
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{trip.name}</div>
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
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Link
                      href={`/trips/${trip.id}`}
                      style={{
                        fontSize: 12,
                        color: '#7CB5E8',
                        textDecoration: 'none',
                        padding: '5px 10px',
                        borderRadius: 5,
                        border: '1px solid rgba(124,181,232,0.3)',
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
