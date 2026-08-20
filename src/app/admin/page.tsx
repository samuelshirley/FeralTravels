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
  getTopUsersAllTime,
  getProviderTotals,
  getAllTimeAnthropicSpend,
  getAnthropicHealthAlert,
} from '@/server/repos/admin';
import { getAnnouncementStats } from '@/server/repos/announcements';
import {
  getGlobalUsage,
  microcentsToDollars,
  getGoogleBillableThisMonth,
} from '@/server/repos/usage';
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

  const [
    overview,
    recentUsers,
    recentChat,
    recentErrors,
    topAllTime,
    usage24,
    usage7d,
    providers7d,
    allTimeAnthropic,
    anthropicAlert,
    // Calendar-month Google bill after subtracting per-SKU free allowances.
    // Internally try/catch'd → returns zeros on failure so it can never 500
    // the whole dashboard. Parallelized into this batch so it doesn't add
    // sequential latency to the page render.
    googleBillable,
    announcementStats,
  ] = await Promise.all([
    getAdminOverview(),
    getRecentUsers(15),
    getRecentChatActivity(15),
    // Home page shows last 15 — full pagination + filters lives at /admin/errors.
    getRecentErrors(15),
    // Combined "who's expensive" view: all-time spend, trip count,
    // avg/trip, last-7d spend, last seen — one row per user.
    getTopUsersAllTime(20),
    getGlobalUsage(24),
    getGlobalUsage(24 * 7),
    // Provider split (last 7d) — surfaces Anthropic vs Google estimate
    // so the all-up cost picture isn't misread as one big Anthropic bill.
    getProviderTotals(24 * 7),
    getAllTimeAnthropicSpend(),
    getAnthropicHealthAlert(),
    getGoogleBillableThisMonth(),
    getAnnouncementStats(),
  ]);

  const usd24 = usage24
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const usd7d = usage7d
    .filter((u) => u.provider === 'anthropic')
    .reduce((sum, u) => sum + microcentsToDollars(u.microcents), 0);
  const projectedMonthly = usd7d * (30 / 7);
  const usdAllTime = microcentsToDollars(allTimeAnthropic.microcents);

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
      label: 'Total vehicles',
      value: overview.totalVehicles,
      href: '/admin/vehicles',
    },
    {
      label: 'Deleted accounts',
      value: overview.totalDeletedUsers,
      sub: 'churn — click for detail',
      href: '/admin/deleted',
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
      sub: `${usage24.find((u) => u.provider === 'anthropic')?.requests ?? 0} req · list-price est.`,
    },
    {
      label: 'AI spend (7d)',
      value: fmtMoney(usd7d),
      sub: `${usage7d.find((u) => u.provider === 'anthropic')?.requests ?? 0} req · rolling 168h · list-price est.`,
    },
    {
      label: 'AI spend (all-time)',
      value: fmtMoney(usdAllTime),
      sub: `${allTimeAnthropic.requests.toLocaleString()} req · list-price est.`,
    },
    {
      label: 'Projected /mo',
      value: fmtMoney(projectedMonthly),
      sub: '×30/7 from 7d est. (not an invoice)',
    },
    {
      label: 'Google billable (mo)',
      value: fmtMoney(googleBillable.billableUsd),
      sub: googleSubLabel(googleBillable),
    },
    {
      label: 'Announcements',
      value: announcementStats.activeCount,
      sub: `${announcementStats.totalCount} total`,
      href: '/admin/announcements',
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
            // Three vertical regions inside every card so heights stay
            // identical across the row even when sub-text or the VIEW ALL
            // chevron is missing on a particular card. Empty regions
            // collapse but still reserve space via the parent flex layout.
            const inner = (
              <>
                <div style={labelStyle}>{s.label.toUpperCase()}</div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: 'var(--tp-text)',
                    lineHeight: 1.1,
                    marginTop: 4,
                  }}
                >
                  {s.value}
                </div>
                <div
                  style={{
                    marginTop: 'auto',
                    paddingTop: 6,
                    minHeight: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {s.sub && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--tp-subtle)',
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
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                      }}
                    >
                      VIEW ALL →
                    </div>
                  )}
                </div>
              </>
            );
            if (s.href) {
              return (
                <Link key={s.label} href={s.href} className={styles.statCard}>
                  {inner}
                </Link>
              );
            }
            return (
              <div key={s.label} className={styles.statCard}>
                {inner}
              </div>
            );
          })}
        </div>

        {/* Provider split (last 7d). Lets you see at a glance whether the
         * dashboard total is mostly Anthropic or mostly Google estimate.
         * Google switched from a unified $200/mo credit to per-SKU monthly
         * free allowances in 2024 — the dashboard subtracts those before
         * showing the "billable" number so it matches your real bill. */}
        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
            Spend by provider (7d)
          </h2>
          <ProviderBreakdown
            rows={providers7d}
            googleBillableMonthGrossUsd={googleBillable.grossUsd}
            googleBillableMonthUsd={googleBillable.billableUsd}
          />
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: 'var(--tp-subtle)',
              lineHeight: 1.5,
            }}
          >
            Anthropic totals here sum our{' '}
            <strong>list-price estimates</strong> from token counts logged with each API
            call — useful for trends and caps, but they can diverge from{' '}
            <a
              href="https://console.anthropic.com/"
              style={{ color: 'var(--tp-primary)' }}
            >
              Anthropic Console
            </a>{' '}
            (billing tiers, rounding, workbench usage, or Section 7 rows in{' '}
            <code>scripts/reconcile-anthropic-spend.ts</code>). For vendor-reported USD,
            use Anthropic&apos;s{' '}
            <a
              href="https://docs.anthropic.com/en/api/data-usage-cost-api"
              style={{ color: 'var(--tp-primary)' }}
            >
              Usage &amp; Cost API
            </a>{' '}
            (requires an organization admin API key). Google = list-price estimate; the
            dashboard subtracts per-SKU monthly free allowances (configured
            via <code>GOOGLE_PLACES_FREE_CALLS_*</code> env vars) so the
            &quot;billable&quot; figure matches your Google Cloud invoice.
            The 7d number is the raw gross estimate for context — the
            month-to-date billable is in the stat card above. Verify free
            allowances at{' '}
            <a
              href="https://developers.google.com/maps/billing-and-pricing/pricing"
              style={{ color: 'var(--tp-primary)' }}
            >
              Google&apos;s pricing page
            </a>
            .
          </div>
        </section>

        <div className={styles.bottomGrid}>
          <section style={{ ...card, gridColumn: '1 / -1' }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Top spenders — all-time
            </h2>
            <AllTimeUsageTable rows={topAllTime} />
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
            {/* Desktop: dense 2-col table. Mobile: stacked cards so the
                row never forces horizontal scroll on a narrow viewport. */}
            <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
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
            <div className={styles.mobileOnly}>
              {recentUsers.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
                  No users yet.
                </div>
              ) : (
                recentUsers.map((u) => (
                  <Link
                    key={u.id}
                    href={`/admin/users/${u.id}`}
                    className={styles.mobileRowCard}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name || '—'}</div>
                    {u.email && (
                      <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 2 }}>
                        {u.email}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--tp-muted)', marginTop: 6 }}>
                      Joined {fmtRel(u.createdAt)}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Recent chat activity
            </h2>
            {/* Desktop: 4-col table. Mobile: stacked cards (4 cols
                including the snippet was way too wide for a phone). */}
            <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
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
            <div className={styles.mobileOnly}>
              {recentChat.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
                  No chat activity yet.
                </div>
              ) : (
                recentChat.map((m) => (
                  <Link
                    key={m.id}
                    href={`/admin/chats/${m.tripId}`}
                    className={styles.mobileRowCard}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 8,
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color:
                            m.role === 'assistant' ? 'var(--tp-success)' : 'var(--tp-muted)',
                        }}
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
                        <span style={{ marginLeft: 8, color: 'var(--tp-primary)' }}>
                          #{m.tripId}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
                        {fmtRel(m.createdAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--tp-text)',
                        lineHeight: 1.4,
                        // Two-line clamp; full message is on the chat
                        // detail page if needed.
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {m.content}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>

        {/*
          Recent API failures lives at the bottom now — most of the time
          it's empty (no failures in 19+ days) so it's wasted real estate
          near the top. Keeping it on the page so we still notice when
          things break, just out of the way.
        */}
        <section style={{ ...card, marginTop: 16 }}>
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
      </main>

    </div>
  );
}

/**
 * Build the sub-text under the "Google billable (mo)" stat card. Shows
 * how much of each SKU's free allowance has been consumed so far this
 * month, and the gross (pre-free-tier) estimate for context.
 */
function googleSubLabel(billable: {
  grossUsd: number;
  perSku: Array<{ sku: string; calls: number; freeCalls: number }>;
}): string {
  if (billable.perSku.length === 0) return 'no Places calls this month';
  const totalCalls = billable.perSku.reduce((s, r) => s + r.calls, 0);
  const totalFree = billable.perSku.reduce((s, r) => s + r.freeCalls, 0);
  return `gross ${`$${billable.grossUsd.toFixed(billable.grossUsd >= 1 ? 2 : 4)}`} · ${totalCalls.toLocaleString()}/${totalFree.toLocaleString()} free calls used`;
}

/**
 * Provider breakdown card. Shows requests + estimated cost per provider
 * for the time window the parent passes in. Intended for the section
 * that explains "your dashboard total = $X Anthropic (list est.) + $Y Google estimate".
 *
 * For Google rows, the headline number is the month-to-date BILLABLE
 * (after subtracting per-SKU free allowances) and the gross is shown as
 * smaller context — that's what actually hits your invoice.
 */
function ProviderBreakdown({
  rows,
  googleBillableMonthGrossUsd,
  googleBillableMonthUsd,
}: {
  rows: Array<{ provider: string; requests: number; microcents: number }>;
  googleBillableMonthGrossUsd: number;
  googleBillableMonthUsd: number;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
        No usage in this window.
      </div>
    );
  }
  // Sort: anthropic first (primary LLM estimate), everything else after.
  const sorted = [...rows].sort((a, b) => {
    if (a.provider === 'anthropic') return -1;
    if (b.provider === 'anthropic') return 1;
    return a.provider.localeCompare(b.provider);
  });
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
      }}
    >
      {sorted.map((r) => {
        const isAnthropic = r.provider === 'anthropic';
        const isGoogle = r.provider.startsWith('google');
        const grossUsd7d = microcentsToDollars(r.microcents);
        return (
          <div
            key={r.provider}
            style={{
              padding: '10px 12px',
              border: '1px solid var(--tp-border)',
              borderRadius: 8,
              background: 'var(--tp-bg)',
            }}
          >
            <div style={{ ...labelStyle, marginBottom: 4 }}>
              {r.provider}
              {isAnthropic && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 9,
                    color: 'var(--tp-subtle)',
                    fontWeight: 500,
                    letterSpacing: 0,
                  }}
                >
                  (list-price est., 7d)
                </span>
              )}
              {isGoogle && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 9,
                    color: 'var(--tp-subtle)',
                    fontWeight: 500,
                    letterSpacing: 0,
                  }}
                >
                  (after free tier, mo)
                </span>
              )}
              {!isAnthropic && !isGoogle && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 9,
                    color: 'var(--tp-subtle)',
                    fontWeight: 500,
                    letterSpacing: 0,
                  }}
                >
                  (estimate)
                </span>
              )}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>
              {isGoogle
                ? fmtMoney(googleBillableMonthUsd)
                : fmtMoney(grossUsd7d)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 2 }}>
              {isGoogle ? (
                <>
                  {r.requests.toLocaleString()} req (7d) ·{' '}
                  {fmtMoney(googleBillableMonthGrossUsd)} gross/mo
                </>
              ) : (
                <>{r.requests.toLocaleString()} req</>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * All-time spender table — total spend, trips, avg cost per trip,
 * last-7d spend, and last-seen, joined per user. Built specifically to
 * answer "who is costing me money and how active are they?" in one
 * sortable view.
 *
 * Avg/trip is null when the user has no trips (their spend was incurred
 * on a trip that's since been deleted, or before trip creation completed).
 * We render '—' rather than dividing by zero.
 */
function AllTimeUsageTable({
  rows,
}: {
  rows: Array<{
    userId: string | null;
    email: string | null;
    name: string | null;
    requests: number;
    microcents: number;
    microcents7d: number;
    tripCount: number;
    lastSeenAt: Date | string;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '12px 4px' }}>
        No AI usage recorded yet.
      </div>
    );
  }
  return (
    <>
    {/* Desktop: 6-col table. Mobile: stacked cards with the same data
        re-flowed (User name + email on top, then a 4-up grid of
        Total / Trips / Avg/trip / Last 7d, then Last seen as muted
        meta). 6 cols on a phone was the worst overflow on the page. */}
    <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle}>User</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Trips</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Avg / trip</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Last 7d</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const total = microcentsToDollars(r.microcents);
            const last7d = microcentsToDollars(r.microcents7d);
            const avgPerTrip = r.tripCount > 0 ? total / r.tripCount : null;
            const cells = (
              <>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-success)' }}>
                  {fmtMoney(total)}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{r.tripCount}</td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  {avgPerTrip != null ? fmtMoney(avgPerTrip) : '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  {last7d > 0 ? fmtMoney(last7d) : '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  {fmtRel(r.lastSeenAt)}
                </td>
              </>
            );
            // Anonymous / orphaned usage rows — render plain (no drill-in target).
            if (!r.userId) {
              return (
                <tr key={`anon-${i}`}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>(unknown)</div>
                  </td>
                  {cells}
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
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-success)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {fmtMoney(total)}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {r.tripCount}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {avgPerTrip != null ? fmtMoney(avgPerTrip) : '—'}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {last7d > 0 ? fmtMoney(last7d) : '—'}
                  </Link>
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--tp-muted)' }}>
                  <Link
                    href={`/admin/users/${r.userId}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {fmtRel(r.lastSeenAt)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    <div className={styles.mobileOnly}>
      {rows.map((r, i) => {
        const total = microcentsToDollars(r.microcents);
        const last7d = microcentsToDollars(r.microcents7d);
        const avgPerTrip = r.tripCount > 0 ? total / r.tripCount : null;
        const inner = (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 8,
                marginBottom: 6,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.name || r.email || '(unknown)'}
                </div>
                {r.email && r.name && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--tp-subtle)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.email}
                  </div>
                )}
              </div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--tp-success)',
                  whiteSpace: 'nowrap',
                }}
              >
                ${total.toFixed(total >= 1 ? 2 : 4)}
              </div>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 4,
                fontSize: 11,
                color: 'var(--tp-muted)',
                marginTop: 4,
              }}
            >
              <div>
                <span style={{ color: 'var(--tp-subtle)' }}>Trips </span>
                {r.tripCount}
              </div>
              <div>
                <span style={{ color: 'var(--tp-subtle)' }}>Avg </span>
                {avgPerTrip != null ? `$${avgPerTrip.toFixed(avgPerTrip >= 1 ? 2 : 4)}` : '—'}
              </div>
              <div>
                <span style={{ color: 'var(--tp-subtle)' }}>7d </span>
                {last7d > 0 ? `$${last7d.toFixed(last7d >= 1 ? 2 : 4)}` : '—'}
              </div>
            </div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--tp-subtle)',
                marginTop: 6,
              }}
            >
              Last seen {fmtRel(r.lastSeenAt)}
            </div>
          </>
        );
        if (!r.userId) {
          return (
            <div key={`anon-${i}`} className={styles.mobileRowCard} style={{ cursor: 'default' }}>
              {inner}
            </div>
          );
        }
        return (
          <Link
            key={r.userId}
            href={`/admin/users/${r.userId}`}
            className={styles.mobileRowCard}
          >
            {inner}
          </Link>
        );
      })}
    </div>
    <div
      style={{
        fontSize: 11,
        color: 'var(--tp-subtle)',
        marginTop: 12,
        lineHeight: 1.45,
      }}
    >
      Dollar amounts sum{' '}
      <code style={{ fontSize: 10 }}>usage_events</code> rows with{' '}
      <code style={{ fontSize: 10 }}>provider = anthropic</code> only (list-price estimate). Google usage
      and diagnostic providers such as <code style={{ fontSize: 10 }}>anthropic:replan</code> are not included
      in this ranking. Turns that disconnect before Penny finishes still record Anthropic totals when billing
      did occur; failures to persist the accounting row emit{' '}
      <code style={{ fontSize: 10 }}>anthropic:accounting-write-failed</code> for the Recent errors panel. Trip
      counts exclude templates (see averages above).
    </div>
    </>
  );
}

