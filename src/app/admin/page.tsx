import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import {
  getAdminOverview,
  getRecentUsers,
  getRecentChatActivity,
  getRecentErrors,
  getTopUsageUsers,
} from '@/server/repos/admin';
import { getGlobalUsage, microcentsToDollars } from '@/server/repos/usage';
import AppNavbar from '@/components/AppNavbar';
import AdminErrorLog from './AdminErrorLog';
import AdminTestErrorButton from './AdminTestErrorButton';
import styles from './admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtMoney(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

function fmtRel(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 16,
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.15em',
  color: 'rgba(255,255,255,0.4)',
  fontFamily: "'JetBrains Mono', monospace",
  marginBottom: 6,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  fontSize: 12,
  color: 'rgba(255,255,255,0.85)',
};

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.12)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'rgba(255,255,255,0.45)',
  fontFamily: "'JetBrains Mono', monospace",
  textAlign: 'left',
  textTransform: 'uppercase',
};

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Silent redirect — no error page, no info leak that /admin even exists.
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const [overview, recentUsers, recentChat, recentErrors, top24, top7d, usage24, usage7d] =
    await Promise.all([
      getAdminOverview(),
      getRecentUsers(15),
      getRecentChatActivity(20),
      getRecentErrors(50),
      getTopUsageUsers(24, 10),
      getTopUsageUsers(24 * 7, 10),
      getGlobalUsage(24),
      getGlobalUsage(24 * 7),
    ]);

  const usd24 = usage24
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const usd7d = usage7d
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const projectedMonthly = usd7d * (30 / 7);

  const stats: Array<{ label: string; value: string | number; sub?: string }> = [
    { label: 'Total users', value: overview.totalUsers, sub: `+${overview.newUsers7d} (7d)` },
    { label: 'Active trips', value: overview.totalTrips, sub: `${overview.totalTemplates} template(s)` },
    { label: 'Legs planned', value: overview.totalLegs },
    { label: 'Chat messages', value: overview.totalChat, sub: `${overview.totalReplans} Penny edits` },
    { label: 'GPX trails uploaded', value: overview.totalGpx },
    { label: 'New signups (24h)', value: overview.newUsers24h, sub: `+${overview.newUsers7d} (7d)` },
    { label: 'AI spend (24h)', value: fmtMoney(usd24), sub: `${usage24.find((u) => u.provider === 'anthropic')?.requests ?? 0} req` },
    { label: 'AI spend (7d)', value: fmtMoney(usd7d), sub: `~${fmtMoney(projectedMonthly)}/mo projected` },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
      />

      <main
        className={styles.main}
        style={{
          flex: 1,
          maxWidth: 1240,
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            marginBottom: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={labelStyle}>SYSTEM</div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Admin</h1>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.45)',
              fontFamily: "'JetBrains Mono', monospace",
              marginLeft: 4,
            }}
          >
            signed in as {session.user.email}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}
        >
          {stats.map((s) => (
            <div key={s.label} style={card}>
              <div style={labelStyle}>{s.label.toUpperCase()}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>
                {s.value}
              </div>
              {s.sub && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.45)',
                    fontFamily: "'JetBrains Mono', monospace",
                    marginTop: 4,
                  }}
                >
                  {s.sub}
                </div>
              )}
            </div>
          ))}
        </div>

        <section style={{ ...card, marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              Recent errors
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.45)',
                  fontWeight: 500,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {recentErrors.length === 50 ? '50+' : recentErrors.length}
              </span>
            </h2>
            <AdminTestErrorButton />
          </div>
          <AdminErrorLog
            rows={recentErrors.map((e) => ({
              id: e.id,
              createdAt: (e.createdAt instanceof Date
                ? e.createdAt
                : new Date(e.createdAt)
              ).toISOString(),
              provider: e.provider,
              errorMessage: e.errorMessage,
              tripId: e.tripId,
              userId: e.userId,
              userEmail: e.userEmail,
              userName: e.userName,
            }))}
          />
        </section>

        <div className={styles.bottomGrid}>
          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Top spenders (24h) — Anthropic
            </h2>
            <UsageTable rows={top24} />
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Top spenders (7d) — Anthropic
            </h2>
            <UsageTable rows={top7d} />
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Recent users
            </h2>
            <div className={styles.tableScroll}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>User</th>
                  <th style={thStyle}>Joined</th>
                </tr>
              </thead>
              <tbody>
                {recentUsers.map((u) => (
                  <tr key={u.id}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{u.name || '—'}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'rgba(255,255,255,0.45)',
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {u.email}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)' }}>
                      {fmtRel(u.createdAt)}
                    </td>
                  </tr>
                ))}
                {recentUsers.length === 0 && (
                  <tr>
                    <td colSpan={2} style={{ ...tdStyle, color: 'rgba(255,255,255,0.4)' }}>
                      No users yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Recent chat activity
            </h2>
            <div className={styles.tableScroll}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Trip</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Snippet</th>
                  <th style={thStyle}>When</th>
                </tr>
              </thead>
              <tbody>
                {recentChat.map((m) => (
                  <tr key={m.id}>
                    <td style={tdStyle}>
                      <Link
                        href={`/trips/${m.tripId}`}
                        style={{ color: '#7CB5E8', textDecoration: 'none' }}
                      >
                        #{m.tripId}
                      </Link>
                    </td>
                    <td style={{ ...tdStyle, color: m.role === 'assistant' ? '#7CE8A3' : 'rgba(255,255,255,0.7)' }}>
                      {m.role}
                      {m.hasChanges && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: '#7CE8A3', fontFamily: "'JetBrains Mono', monospace" }}>
                          ✓EDIT
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: 'rgba(255,255,255,0.7)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.content.slice(0, 80)}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)' }}>
                      {fmtRel(m.createdAt)}
                    </td>
                  </tr>
                ))}
                {recentChat.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ ...tdStyle, color: 'rgba(255,255,255,0.4)' }}>
                      No chat activity yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </section>
        </div>

        <p
          style={{
            marginTop: 32,
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.6,
          }}
        >
          AI spend is estimated from Anthropic public list pricing for the model in use. Google
          Maps JS / Directions client-side calls are not tracked here — set hard quotas in Google
          Cloud Console for those. Per-user limits: {process.env.REPLAN_REQUESTS_PER_HOUR || 40}
          {' '}requests/hour and ${parseFloat(process.env.REPLAN_USD_CAP_PER_DAY || '5').toFixed(2)} AI spend/day.
        </p>
      </main>
    </div>
  );
}

function UsageTable({
  rows,
}: {
  rows: Array<{
    userId: string | null;
    email: string | null;
    name: string | null;
    requests: number;
    microcents: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', padding: '12px 4px' }}>
        No AI calls in this window.
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={thStyle}>User</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Reqs</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Tokens</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.userId || `anon-${i}`}>
            <td style={tdStyle}>
              <div style={{ fontWeight: 600 }}>{r.name || r.email || '(unknown)'}</div>
              {r.email && r.name && (
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {r.email}
                </div>
              )}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>
              {r.requests}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.55)' }}>
              {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: '#7CE8A3' }}>
              {fmtMoney(microcentsToDollars(r.microcents))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
