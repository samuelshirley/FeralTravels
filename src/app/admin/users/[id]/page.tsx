import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getUserDetail } from '@/server/repos/admin';
import { microcentsToDollars } from '@/server/repos/usage';
import AppNavbar from '@/components/AppNavbar';
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

function fmtAbs(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 16).replace('T', ' ');
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

  const lifetimeUsd = microcentsToDollars(detail.spend.lifetimeMicrocents);
  const sevenDayUsd = microcentsToDollars(detail.spend.microcents7d);

  const activeTrips = detail.trips.filter((t) => !t.isTemplate);
  const templates = detail.trips.filter((t) => t.isTemplate);

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
