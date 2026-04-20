import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAdminOverview } from '@/server/repos/admin';
import { getGlobalUsage, microcentsToDollars } from '@/server/repos/usage';
import AppNavbar from '@/components/AppNavbar';
import VehicleProfileSection from '@/components/VehicleProfileSection';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const admin = await isAdmin(session.user.email);

  // Grab a quick admin summary server-side so we can render live numbers
  // right in the Settings card. Safe: page isn't shipped unless admin=true.
  const adminStats = admin
    ? await Promise.all([getAdminOverview(), getGlobalUsage(24), getGlobalUsage(24 * 7)])
    : null;
  const overview = adminStats?.[0];
  const usd24 = adminStats
    ? adminStats[1]
        .filter((u) => u.provider === 'anthropic')
        .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0)
    : 0;
  const usd7d = adminStats
    ? adminStats[2]
        .filter((u) => u.provider === 'anthropic')
        .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0)
    : 0;

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
      <div
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: '32px 16px 80px',
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.15em',
            marginBottom: 4,
          }}
        >
          USER
        </div>
        <h1 style={{ margin: 0, marginBottom: 24, fontSize: 28, fontWeight: 700 }}>Settings</h1>

        <section
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            padding: 20,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
            Signed in as
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
            {session.user.name || session.user.email}
          </div>
          {session.user.email && session.user.name && (
            <div
              style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.4)',
                fontFamily: "'JetBrains Mono', monospace",
                marginTop: 4,
              }}
            >
              {session.user.email}
            </div>
          )}
        </section>

        <section
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            padding: 20,
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, marginBottom: 6, fontSize: 16, fontWeight: 700 }}>
            Vehicle profile
          </h2>
          <p style={{ margin: 0, marginBottom: 14, fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
            Penny uses these constraints to keep your plan realistic — max drive hours/day, fuel
            range, vehicle clearance, and water/black-water intervals.
          </p>
          <VehicleProfileSection />
        </section>

        {admin && overview && (
          <>
            <div
              style={{
                fontSize: 11,
                color: 'rgba(232,193,124,0.65)',
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: '0.15em',
                marginTop: 32,
                marginBottom: 4,
              }}
            >
              ADMIN
            </div>
            <section
              style={{
                background: 'rgba(232,193,124,0.06)',
                border: '1px solid rgba(232,193,124,0.25)',
                borderRadius: 10,
                padding: 20,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 16,
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>System overview</h2>
                  <p
                    style={{
                      margin: 0,
                      marginTop: 4,
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.45)',
                    }}
                  >
                    Visible only to you. Live numbers from Neon + usage_events.
                  </p>
                </div>
                <Link
                  href="/admin"
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '7px 12px',
                    background: '#E8C17C',
                    color: '#0D0D0D',
                    borderRadius: 6,
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Open admin dashboard →
                </Link>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                  gap: 10,
                }}
              >
                <Stat label="Users" value={overview.totalUsers} sub={`+${overview.newUsers7d} (7d)`} />
                <Stat label="Active trips" value={overview.totalTrips} />
                <Stat label="Chat msgs" value={overview.totalChat} sub={`${overview.totalReplans} Penny edits`} />
                <Stat label="GPX trails" value={overview.totalGpx} />
                <Stat label="AI spend 24h" value={fmtMoney(usd24)} highlight />
                <Stat label="AI spend 7d" value={fmtMoney(usd7d)} sub={`~${fmtMoney(usd7d * (30 / 7))}/mo proj.`} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function fmtMoney(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

function Stat({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string | number;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        background: highlight ? 'rgba(124,232,163,0.06)' : 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: 'rgba(255,255,255,0.4)',
          fontFamily: "'JetBrains Mono', monospace",
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: highlight ? '#7CE8A3' : '#fff',
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.45)',
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
