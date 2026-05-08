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
  getAnthropicHealthAlert,
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
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.15em',
  color: 'var(--tp-subtle)',
  marginBottom: 6,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--tp-border)',
  fontSize: 12,
  color: 'var(--tp-text)',
};

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--tp-border-strong)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--tp-muted)',
  textAlign: 'left',
  textTransform: 'uppercase',
};

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Silent redirect — no error page, no info leak that /admin even exists.
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const [overview, recentUsers, recentChat, recentErrors, top24, top7d, usage24, usage7d, anthropicAlert] =
    await Promise.all([
      getAdminOverview(),
      getRecentUsers(15),
      getRecentChatActivity(15),
      // Home page shows last 15 — full pagination + filters lives at /admin/errors.
      getRecentErrors(15),
      getTopUsageUsers(24, 10),
      getTopUsageUsers(24 * 7, 10),
      getGlobalUsage(24),
      getGlobalUsage(24 * 7),
      getAnthropicHealthAlert(),
    ]);

  const usd24 = usage24
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const usd7d = usage7d
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const projectedMonthly = usd7d * (30 / 7);

  // Stat cards. `href` makes the card a Link to its drill-in page.
  // Others stay as plain numbers (no useful drill-in yet).
  const stats: Array<{
    label: string;
    value: string | number;
    sub?: string;
    href?: string;
  }> = [
    {
      label: 'Total users',
      value: overview.totalUsers,
      sub: `+${overview.newUsers7d} (7d)`,
      href: '/admin/users',
    },
    {
      label: 'Active trips',
      value: overview.totalTrips,
      sub: `${overview.totalTemplates} template(s)`,
    },
    { label: 'Legs planned', value: overview.totalLegs },
    {
      label: 'Chat messages',
      value: overview.totalChat,
      sub: `${overview.totalReplans} Penny edits`,
    },
    { label: 'GPX trails uploaded', value: overview.totalGpx },
    {
      label: 'New signups (24h)',
      value: overview.newUsers24h,
      sub: `+${overview.newUsers7d} (7d)`,
    },
    {
      label: 'AI spend (24h)',
      value: fmtMoney(usd24),
      sub: `${usage24.find((u) => u.provider === 'anthropic')?.requests ?? 0} req`,
    },
    {
      label: 'AI spend (7d)',
      value: fmtMoney(usd7d),
      sub: `~${fmtMoney(projectedMonthly)}/mo projected`,
    },
  ];

  return (
    <div className={styles.wrapper}>
      <AppNavbar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image,
        }}
        isAdmin
      />

      <main className={styles.main}>
        {anthropicAlert && (
          <div
            style={{
              background: '#7C1D1D',
              border: '1px solid #B91C1C',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#FCA5A5', marginBottom: 4 }}>
                Anthropic API is failing — {anthropicAlert.failureCount} error{anthropicAlert.failureCount !== 1 ? 's' : ''} in the last hour
              </div>
              <div style={{ fontSize: 12, color: '#FCA5A5', opacity: 0.85 }}>
                {anthropicAlert.lastError ?? 'Unknown error'}
              </div>
              <div style={{ fontSize: 11, color: '#FCA5A5', opacity: 0.6, marginTop: 4 }}>
                Check your Anthropic API key and credit balance. Last failure:{' '}
                {anthropicAlert.lastFailedAt
                  ? fmtRel(anthropicAlert.lastFailedAt)
                  : 'unknown'}
                {' · '}
                <a href="/admin/errors" style={{ color: '#FCA5A5' }}>View all errors →</a>
              </div>
            </div>
          </div>
        )}
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
              color: 'var(--tp-subtle)',
              marginLeft: 4,
            }}
          >
            signed in as {session.user.email}
          </div>
        </div>

        <div className={styles.statsGrid}>
          {stats.map((s) => {
            const inner = (
              <>
                <div style={labelStyle}>{s.label.toUpperCase()}</div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: 'var(--tp-text)',
                    lineHeight: 1.1,
                  }}
                >
                  {s.value}
                </div>
                {s.sub && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--tp-subtle)',
                      marginTop: 4,
                    }}
                  >
                    {s.sub}
                  </div>
                )}
                {s.href && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--tp-primary)',
                      marginTop: 6,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                    }}
                  >
                    VIEW ALL →
                  </div>
                )}
              </>
            );
            if (s.href) {
              return (
                <Link key={s.label} href={s.href} className={styles.cardLink} style={card}>
                  {inner}
                </Link>
              );
            }
            return (
              <div key={s.label} style={card}>
                {inner}
              </div>
            );
          })}
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
              Recent API failures
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: 'var(--tp-subtle)',
                  fontWeight: 500,
                }}
              >
                last {recentErrors.length}
              </span>
            </h2>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Link href="/admin/errors" className={styles.seeAllLink}>
                See all errors →
              </Link>
              <AdminTestErrorButton />
            </div>
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
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Recent users</h2>
              <Link href="/admin/users" className={styles.seeAllLink}>
                All users →
              </Link>
            </div>
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
                    <tr key={u.id} className={styles.rowLink}>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}
                        >
                          <div style={{ fontWeight: 600 }}>{u.name || '—'}</div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--tp-subtle)',
                            }}
                          >
                            {u.email}
                          </div>
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}
                        >
                          {fmtRel(u.createdAt)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {recentUsers.length === 0 && (
                    <tr>
                      <td colSpan={2} style={{ ...tdStyle, color: 'var(--tp-subtle)' }}>
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
                    <tr key={m.id} className={styles.rowLink}>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/chats/${m.tripId}`}
                          style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                        >
                          #{m.tripId}
                        </Link>
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          color:
                            m.role === 'assistant' ? 'var(--tp-success)' : 'var(--tp-muted)',
                        }}
                      >
                        <Link
                          href={`/admin/chats/${m.tripId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {m.role}
                          {m.hasChanges && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 9,
                                color: 'var(--tp-success)',
                              }}
                            >
                              ✓EDIT
                            </span>
                          )}
                        </Link>
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          color: 'var(--tp-muted)',
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Link
                          href={`/admin/chats/${m.tripId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {m.content.slice(0, 80)}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/chats/${m.tripId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {fmtRel(m.createdAt)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {recentChat.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ ...tdStyle, color: 'var(--tp-subtle)' }}>
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
            color: 'var(--tp-subtle)',
            lineHeight: 1.6,
          }}
        >
          AI spend is estimated from Anthropic public list pricing for the model in use. Google
          Maps JS / Directions client-side calls are not tracked here — set hard quotas in Google
          Cloud Console for those. Per-user limits: {process.env.REPLAN_REQUESTS_PER_HOUR || 40}
          {' '}requests/hour and ${parseFloat(process.env.REPLAN_USD_CAP_PER_DAY || '5').toFixed(2)} AI spend/day.
          {' '}Admins on the hardcoded allowlist are exempt from both caps (usage is still recorded).
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
      <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '12px 4px' }}>
        No AI calls in this window.
      </div>
    );
  }
  return (
    <div className={styles.tableScroll}>
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
          {rows.map((r, i) => {
            // Anonymous / orphaned usage rows — render plain (no drill-in target).
            if (!r.userId) {
              return (
                <tr key={`anon-${i}`}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>(unknown)</div>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{r.requests}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-success)' }}>
                    {fmtMoney(microcentsToDollars(r.microcents))}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={r.userId} className={styles.rowLink}>
                <td style={tdStyle}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}
                  >
                    <div style={{ fontWeight: 600 }}>{r.name || r.email || '(unknown)'}</div>
                    {r.email && r.name && (
                      <div style={{ fontSize: 10, color: 'var(--tp-subtle)' }}>{r.email}</div>
                    )}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {r.requests}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-success)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {fmtMoney(microcentsToDollars(r.microcents))}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
