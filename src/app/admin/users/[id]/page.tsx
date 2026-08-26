import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getUserDetail, getSubscriptionEventsForUser } from '@/server/repos/admin';
import { microcentsToDollars } from '@/server/repos/usage';
import {
  alertAlreadyFired,
  anthropicMicrocentsInWindow,
  getAccountVerdict,
  getSubscriptionRow,
  MICROCENTS_PER_DOLLAR,
  STOP_MICROCENTS,
  WATCH_MICROCENTS,
} from '@/server/payments';
import AppNavbar from '@/components/AppNavbar';
import RevokeAccessControl from './RevokeAccessControl';
import styles from '../../admin.module.css';

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

/**
 * Relative time that works in BOTH directions.
 *
 * `fmtRel` above assumes the past — every timestamp it was written for had
 * already happened. A period end and a trial end are in the future, and
 * running them through it renders "-518400s ago", which is both wrong and
 * unreadable.
 */
function fmtWhen(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return fmtRel(date);
  const days = Math.ceil(ms / 86_400_000);
  if (days > 1) return `in ${days}d`;
  const hours = Math.ceil(ms / 3_600_000);
  return hours > 1 ? `in ${hours}h` : 'in under an hour';
}

function fmtAbs(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** Whole seconds from DB → readable duration */
function fmtDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '—';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
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
  textTransform: 'uppercase',
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

interface PageProps {
  params: { id: string };
}

export default async function AdminUserDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const detail = await getUserDetail(params.id);
  if (!detail) notFound();

  /*
   * Payments facts, all read through `@/server/payments` — the admin panel is
   * a reader here, never a second opinion. `getAccountVerdict` is the SAME
   * call the paywall makes, so what this page shows is by construction what
   * the user is experiencing, rather than a re-derivation from the status
   * column that could disagree with it.
   */
  const [verdict, subscription, spend12mo, watchFired, stopFired, subEvents] = await Promise.all([
    getAccountVerdict(params.id),
    getSubscriptionRow(params.id),
    anthropicMicrocentsInWindow(params.id),
    alertAlreadyFired(params.id, 'watch'),
    alertAlreadyFired(params.id, 'stop'),
    getSubscriptionEventsForUser(params.id),
  ]);

  const spend12moUsd = spend12mo / MICROCENTS_PER_DOLLAR;
  const thresholds = [
    { key: 'watch' as const, label: 'WATCH', limit: WATCH_MICROCENTS, fired: watchFired },
    { key: 'stop' as const, label: 'STOP', limit: STOP_MICROCENTS, fired: stopFired },
  ];

  /*
   * Only counts as "paid time remaining" if the clock has not already run out.
   * A null period end is unlimited access (an admin grant or a lifetime promo)
   * and is NOT a date to show in the confirmation — "paid through null" would
   * be worse than saying nothing.
   */
  const periodEnd = subscription?.currentPeriodEnd ?? null;
  const paidThrough =
    periodEnd && periodEnd.getTime() > Date.now() ? periodEnd.toISOString().slice(0, 10) : null;

  const lifetimeUsd = microcentsToDollars(detail.spend.lifetimeMicrocents);
  const sevenDayUsd = microcentsToDollars(detail.spend.microcents7d);

  const activeTrips = detail.trips.filter((t) => !t.isTemplate);
  const templates = detail.trips.filter((t) => t.isTemplate);

  const vt = detail.viewportTime;
  const viewportTotalSec = vt.mobile + vt.tablet + vt.desktop;
  const viewportRows = [
    { key: 'mobile' as const, label: 'Mobile', sub: '< 768px', sec: vt.mobile },
    { key: 'tablet' as const, label: 'Tablet', sub: '768–1023px', sec: vt.tablet },
    { key: 'desktop' as const, label: 'Desktop', sub: '≥ 1024px', sec: vt.desktop },
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
        <nav
          aria-label="Breadcrumb"
          style={{ fontSize: 12, color: 'var(--tp-muted)', marginBottom: 12 }}
        >
          <Link href="/admin" style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}>
            Admin
          </Link>
          {' / '}
          <Link
            href="/admin/users"
            style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
          >
            Users
          </Link>
          {' / '}
          <span>{detail.user.name || detail.user.email || detail.user.id}</span>
        </nav>

        <header style={{ marginBottom: 24 }}>
          <div style={labelStyle}>USER</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
            {detail.user.name || '(no name)'}
          </h1>
          <div style={{ fontSize: 13, color: 'var(--tp-muted)', marginTop: 4 }}>
            {detail.user.email || '(no email)'}
            {detail.user.isAdmin && (
              <span
                style={{
                  marginLeft: 10,
                  padding: '2px 8px',
                  background: 'var(--tp-accent-warm-muted)',
                  color: 'var(--tp-gold)',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                }}
              >
                ADMIN
              </span>
            )}
          </div>
          <div
            style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4, fontFamily: 'monospace' }}
          >
            id: {detail.user.id}
          </div>
        </header>

        {/* Summary stat row */}
        <div className={styles.statsGrid}>
          <div style={card}>
            <div style={labelStyle}>JOINED</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtRel(detail.user.createdAt)}</div>
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
              {fmtAbs(detail.user.createdAt)}
            </div>
          </div>
          <div style={card}>
            <div style={labelStyle}>TRIPS</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{activeTrips.length}</div>
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
              {templates.length > 0 ? `${templates.length} template(s)` : 'no templates'}
            </div>
          </div>
          <div style={card}>
            <div style={labelStyle}>AI SPEND (LIFETIME)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--tp-success)' }}>
              {fmtMoney(lifetimeUsd)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
              {detail.spend.lifetimeRequests} req
            </div>
          </div>
          <div style={card}>
            <div style={labelStyle}>AI SPEND (7D)</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--tp-success)' }}>
              {fmtMoney(sevenDayUsd)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
              {detail.spend.requests7d} req
            </div>
          </div>
        </div>

        {/* ── Subscription & entitlement ─────────────────────────────── */}
        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
            Subscription &amp; entitlement
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <div style={labelStyle}>STATE</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{verdict.state}</div>
            </div>
            <div>
              <div style={labelStyle}>ENTITLED</div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: verdict.entitled ? 'var(--tp-success)' : 'var(--tp-danger)',
                }}
              >
                {verdict.entitled ? 'yes' : 'no'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
                {verdict.blockReason ? `blocked: ${verdict.blockReason}` : 'full access'}
              </div>
            </div>
            <div>
              <div style={labelStyle}>EXISTING TRIPS</div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: verdict.canViewExistingTrips ? 'var(--tp-success)' : 'var(--tp-danger)',
                }}
              >
                {verdict.canViewExistingTrips ? 'readable' : 'closed'}
              </div>
            </div>
            <div>
              <div style={labelStyle}>TRIAL ENDS</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {verdict.trialEndsAt ? fmtAbs(verdict.trialEndsAt) : '—'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>
                {verdict.trialEndsAt ? fmtWhen(verdict.trialEndsAt) : 'past it, or subscribed'}
              </div>
            </div>
          </div>

          {/* The row itself, as stored. `—` never stands in for a NULL period end. */}
          {subscription ? (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Product</th>
                    <th style={thStyle}>Period end</th>
                    <th style={thStyle}>Auto-renew</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{subscription.status}</td>
                    <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>{subscription.source}</td>
                    <td style={{ ...tdStyle, color: 'var(--tp-muted)', fontFamily: 'monospace' }}>
                      {subscription.productId ?? '(none)'}
                    </td>
                    <td style={tdStyle}>
                      {/*
                        A NULL period end means "no end" — an admin grant or a
                        lifetime promo. Rendering it as a blank cell reads as
                        missing data and has already invited the wrong
                        conclusion once; say what it means.
                      */}
                      {subscription.currentPeriodEnd ? (
                        <>
                          {fmtAbs(subscription.currentPeriodEnd)}
                          <span style={{ color: 'var(--tp-subtle)' }}>
                            {' '}
                            ({fmtWhen(subscription.currentPeriodEnd)})
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--tp-gold)', fontWeight: 600 }}>
                          Unlimited — no end date
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                      {subscription.autoRenew ? 'on' : 'off'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>
              No subscription row. That is normal — the seven-day trial is derived from
              the sign-up date and is deliberately not stored.
            </div>
          )}

          {subscription?.revokedAt && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 12px',
                background: 'var(--tp-danger-muted)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--tp-text)',
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: 'var(--tp-danger)' }}>Revoked</strong>{' '}
              {fmtAbs(subscription.revokedAt)} by {subscription.revokedBy ?? '(unknown)'} —{' '}
              {subscription.revokedReason ?? '(no reason recorded)'}
            </div>
          )}

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--tp-border)' }}>
            <RevokeAccessControl
              userId={detail.user.id}
              userLabel={detail.user.email || detail.user.name || detail.user.id}
              paidThrough={paidThrough}
              alreadyRevoked={subscription?.status === 'revoked'}
            />
          </div>
        </section>

        {/* ── Usage thresholds ───────────────────────────────────────── */}
        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 8 }}>
            Anthropic spend vs thresholds (rolling 12 months)
          </h2>
          <p style={{ fontSize: 11, color: 'var(--tp-subtle)', margin: '0 0 12px', lineHeight: 1.5 }}>
            Anthropic only, and every anthropic* provider including the
            accounting-failure rows — this is the exact figure the cap is measured on, so
            it will not match the lifetime card above. Google spend is excluded on
            purpose: it is a gross list-price estimate and gates nothing.
          </p>

          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
            {fmtMoney(spend12moUsd)}
          </div>

          <div className={styles.tableScroll}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Threshold</th>
                  <th style={thStyle}>Limit</th>
                  <th style={thStyle}>Distance</th>
                  <th style={thStyle}>Alert fired</th>
                </tr>
              </thead>
              <tbody>
                {thresholds.map((t) => {
                  const remaining = (t.limit - spend12mo) / MICROCENTS_PER_DOLLAR;
                  const crossed = remaining <= 0;
                  return (
                    <tr key={t.key}>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>{t.label}</td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        {fmtMoney(t.limit / MICROCENTS_PER_DOLLAR)}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          color: crossed ? 'var(--tp-danger)' : 'var(--tp-success)',
                          fontWeight: 600,
                        }}
                      >
                        {crossed
                          ? `crossed by ${fmtMoney(Math.abs(remaining))}`
                          : `${fmtMoney(remaining)} to go`}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        {/*
                          Fired-once bookkeeping, straight from `usage_alerts`.
                          A crossed threshold with no alert means the email
                          never went out — worth knowing, because the alert is
                          the only thing that tells us before the user does.
                        */}
                        {t.fired ? 'yes' : crossed ? 'NO — crossed but never sent' : 'no'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Store event log ────────────────────────────────────────── */}
        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 8 }}>
            Subscription events ({subEvents.length})
          </h2>
          <p style={{ fontSize: 11, color: 'var(--tp-subtle)', margin: '0 0 12px', lineHeight: 1.5 }}>
            Every store notification we accepted for this account. outcome is the
            column to read: an ignored_duplicate explains a retry, and an
            ignored_stale next to a DID_RENEW explains a subscription that looks like it
            should be active and is not.
          </p>
          {subEvents.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>
              No store events for this user.
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Received</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Outcome</th>
                    <th style={thStyle}>Store time</th>
                  </tr>
                </thead>
                <tbody>
                  {subEvents.map((e) => (
                    <tr key={e.id}>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)', whiteSpace: 'nowrap' }}>
                        {fmtAbs(e.receivedAt)}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 600, whiteSpace: 'nowrap' }}>{e.type}</td>
                      <td
                        style={{
                          ...tdStyle,
                          whiteSpace: 'nowrap',
                          color:
                            e.outcome === 'applied'
                              ? 'var(--tp-success)'
                              : e.outcome === 'error' || e.outcome === 'ignored_unknown_user'
                                ? 'var(--tp-danger)'
                                : 'var(--tp-muted)',
                        }}
                      >
                        {e.outcome}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-subtle)', whiteSpace: 'nowrap' }}>
                        {e.eventTimeMs ? fmtAbs(new Date(e.eventTimeMs)) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 8 }}>
            Time by screen size (foreground)
          </h2>
          <p style={{ fontSize: 11, color: 'var(--tp-subtle)', margin: '0 0 12px', lineHeight: 1.5 }}>
            Approximate time in each viewport band while the tab was visible (same breakpoints as the
            app). No backfill — counts only usage after this feature shipped.
          </p>
          {viewportTotalSec === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>
              No viewport time recorded yet — data collects while this user uses the app.
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Screen size</th>
                    <th style={thStyle}>Time</th>
                    <th style={thStyle}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {viewportRows.map((row) => {
                    const pct =
                      viewportTotalSec > 0 ? Math.round((row.sec / viewportTotalSec) * 100) : 0;
                    return (
                      <tr key={row.key}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600 }}>{row.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 2 }}>
                            {row.sub}
                          </div>
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{fmtDuration(row.sec)}</td>
                        <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>{pct}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section style={{ ...card, marginBottom: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
            Trips ({detail.trips.length})
          </h2>
          {detail.trips.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>No trips yet.</div>
          ) : (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Dates</th>
                    <th style={thStyle}>Updated</th>
                    <th style={thStyle}>Chat</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.trips.map((t) => (
                    <tr key={t.id}>
                      <td style={tdStyle}>
                        <Link
                          href={`/trips/${t.id}`}
                          style={{ color: 'var(--tp-primary)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          {t.name}
                        </Link>
                        {t.isTemplate && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 9,
                              color: 'var(--tp-gold)',
                              fontWeight: 700,
                              letterSpacing: '0.08em',
                            }}
                          >
                            TEMPLATE
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>{t.status}</td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        {t.startDate ? `${t.startDate} → ${t.endDate ?? '?'}` : '—'}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        {fmtRel(t.updatedAt)}
                      </td>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/chats/${t.id}`}
                          className={styles.seeAllLink}
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className={styles.bottomGrid}>
          <section style={card}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
                Recent errors ({detail.recentErrors.length})
              </h2>
              <Link
                href={`/admin/errors?userId=${encodeURIComponent(detail.user.id)}`}
                className={styles.seeAllLink}
              >
                All for this user →
              </Link>
            </div>
            {detail.recentErrors.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>
                No errors logged for this user.
              </div>
            ) : (
              <div className={styles.tableScroll}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>When</th>
                      <th style={thStyle}>Provider</th>
                      <th style={thStyle}>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recentErrors.map((e) => (
                      <tr key={e.id}>
                        <td
                          style={{
                            ...tdStyle,
                            color: 'var(--tp-muted)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {fmtRel(e.createdAt)}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--tp-gold)', whiteSpace: 'nowrap' }}>
                          {e.provider}
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            color: 'var(--tp-danger)',
                            maxWidth: 320,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={e.errorMessage ?? ''}
                        >
                          {e.errorMessage || '(no message)'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={card}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
              Recent chat ({detail.recentChat.length})
            </h2>
            {detail.recentChat.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--tp-subtle)' }}>No chat activity.</div>
            ) : (
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
                    {detail.recentChat.map((m) => (
                      <tr key={m.id} className={styles.rowLink}>
                        <td style={tdStyle}>
                          <Link
                            href={`/admin/chats/${m.tripId}`}
                            style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                          >
                            {m.tripName ? m.tripName.slice(0, 24) : `#${m.tripId}`}
                          </Link>
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            color:
                              m.role === 'assistant'
                                ? 'var(--tp-success)'
                                : 'var(--tp-muted)',
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
                          {m.content.slice(0, 80)}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                          {fmtRel(m.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
