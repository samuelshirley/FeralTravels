import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAdminOverview } from '@/server/repos/admin';
import { getGlobalUsage, microcentsToDollars } from '@/server/repos/usage';
import { getUnitsPref } from '@/server/repos/users';
import AppNavbar from '@/components/AppNavbar';
import BottomNav from '@/components/BottomNav';
import VehicleProfileSection from '@/components/VehicleProfileSection';
import DeleteAccountSection from '@/components/DeleteAccountSection';
import { UnitsProvider } from '@/components/UnitsContext';
import UnitsToggle from '@/components/UnitsToggle';
import { requireWebAccess } from '@/server/auth/webAccess';


export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  const userId = session.user.id as string;
  const admin = await isAdmin(session.user.email);
  // Server-render the units pref so the toggle and the Vehicle form labels
  // render in the right state on first paint (no flash of metric for an
  // imperial user).
  const unitsPref = await getUnitsPref(userId);

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
    <UnitsProvider initialUnits={unitsPref}>
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
            // Extra bottom padding accounts for the mobile BottomNav
            // (~70px nav + iPhone home indicator) so the last admin card
            // isn't hidden behind it. On tablet/desktop the nav doesn't
            // mount, but the extra space is harmless.
            padding: '32px 16px calc(80px + env(safe-area-inset-bottom) + 70px)',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: 'var(--tp-subtle)',
              letterSpacing: '0.15em',
              marginBottom: 4,
            }}
          >
            USER
          </div>
          <h1 style={{ margin: 0, marginBottom: 24, fontSize: 28, fontWeight: 700, color: 'var(--tp-text)' }}>Settings</h1>

          {/*
            Display-units toggle lives at the top of Settings because the
            Vehicle profile form below changes its label/placeholder text
            (km vs mi) based on this value. Putting it here means the user
            picks units once and the rest of the page reflects it
            immediately via UnitsContext.
          */}
          <section
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 20,
              marginBottom: 16,
              boxShadow: 'var(--tp-shadow-sm)',
            }}
          >
            <UnitsToggle />
          </section>

          <section
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 20,
              marginBottom: 16,
              boxShadow: 'var(--tp-shadow-sm)',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--tp-muted)', marginBottom: 4 }}>
              Signed in as
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--tp-text)' }}>
              {session.user.name || session.user.email}
            </div>
            {session.user.email && session.user.name && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tp-subtle)',
                  marginTop: 4,
                }}
              >
                {session.user.email}
              </div>
            )}
          </section>

          <section
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 20,
              marginBottom: 16,
              boxShadow: 'var(--tp-shadow-sm)',
            }}
          >
            <h2 style={{ margin: 0, marginBottom: 6, fontSize: 16, fontWeight: 700, color: 'var(--tp-text)' }}>
              Vehicle profile
            </h2>
            {/*
              One line. The old four promised "daily/weekly drive caps" and a
              "water refill / dump cadence", neither of which has been collected
              since migrations 0014/0015 — see the copy rule in CLAUDE.md. Keep
              in step with mobile/app/settings.tsx.
            */}
            <p style={{ margin: 0, marginBottom: 14, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
              Penny plans fuel stops around this range.
            </p>
            <VehicleProfileSection />
          </section>

          {admin && overview && (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--tp-gold)',
                  letterSpacing: '0.15em',
                  marginTop: 32,
                  marginBottom: 4,
                }}
              >
                ADMIN
              </div>
              <section
                style={{
                  background: 'rgba(184, 149, 106, 0.1)',
                  border: '1px solid rgba(184, 149, 106, 0.35)',
                  borderRadius: 'var(--tp-radius-md)',
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
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--tp-text)' }}>System overview</h2>
                    <p
                      style={{
                        margin: 0,
                        marginTop: 4,
                        fontSize: 12,
                        color: 'var(--tp-muted)',
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
                      background: 'var(--tp-gold)',
                      color: 'var(--tp-text)',
                      borderRadius: 'var(--tp-radius-sm)',
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

          {/*
            Very bottom of the page, below the admin block, because it is the
            most destructive thing on it and nothing should sit under it. The
            typing gesture and the confirm dialog live inside the component.
          */}
          <DeleteAccountSection />
        </div>

        <BottomNav active="settings" />
      </div>
    </UnitsProvider>
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
        background: highlight ? 'var(--tp-success-muted)' : 'var(--tp-surface-muted)',
        border: '1px solid var(--tp-border)',
        borderRadius: 'var(--tp-radius-sm)',
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          color: 'var(--tp-subtle)',
          
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
          color: highlight ? 'var(--tp-success)' : 'var(--tp-text)',
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--tp-muted)',
            
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
