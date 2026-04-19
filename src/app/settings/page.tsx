import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import AppNavbar from '@/components/AppNavbar';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
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
          }}
        >
          <h2 style={{ margin: 0, marginBottom: 6, fontSize: 16, fontWeight: 700 }}>
            Vehicle profile
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
            Coming soon — height, fuel economy, max driving hours per day/week, fuel tank size, and
            water/black-water refill intervals. Penny will use these constraints to keep your plan
            realistic and flag any leg that goes out of spec.
          </p>
        </section>
      </div>
    </div>
  );
}
