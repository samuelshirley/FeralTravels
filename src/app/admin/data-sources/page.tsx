import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getDataSourceHealth } from '@/server/dataSourceHealth';
import AppNavbar from '@/components/AppNavbar';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function fmtRel(iso: string): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

const SOURCE_LABEL: Record<string, string> = {
  overpass: 'OSM Overpass — station search',
  osrm: 'OSRM — route geometry',
};

export default async function AdminDataSourcesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const { sources, recent } = await getDataSourceHealth();

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
        <div style={{ marginBottom: 24 }}>
          <div style={labelStyle}>FINN</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Fuel data sources</h1>
          <div style={{ fontSize: 12, color: 'var(--tp-subtle)', marginTop: 6, lineHeight: 1.5, maxWidth: 640 }}>
            Overpass (stations) and OSRM (routing) run on free public instances by
            default — fair-use only, not for a production backend. Rate-limit hits
            below are the signal to self-host (set{' '}
            <code>OVERPASS_ENDPOINT</code> / <code>OSRM_ENDPOINT</code>). You also get
            an email on the first hit, then ~1h of quiet.
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            marginBottom: 20,
          }}
        >
          {sources.map((s) => {
            const healthy = s.rateLimited24h === 0;
            return (
              <div key={s.source} style={card}>
                <div style={labelStyle}>{SOURCE_LABEL[s.source] ?? s.source}</div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    marginTop: 4,
                    color: healthy ? 'var(--tp-success)' : 'var(--tp-danger)',
                  }}
                >
                  {healthy ? 'OK' : `${s.rateLimited24h} rate-limited (24h)`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 6, lineHeight: 1.5 }}>
                  {s.rateLimited7d} in 7d
                  {s.lastRateLimitedAt ? ` · last ${fmtRel(s.lastRateLimitedAt)}` : ' · none recorded'}
                  <br />
                  <span style={{ color: s.selfHosted ? 'var(--tp-success)' : 'var(--tp-muted)' }}>
                    {s.selfHosted ? '● self-hosted: ' : '○ public: '}
                  </span>
                  <code style={{ fontSize: 10 }}>{s.endpoint}</code>
                </div>
              </div>
            );
          })}
        </div>

        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, marginBottom: 12 }}>
            Recent rate-limit events
          </h2>
          {recent.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
              No rate-limit events recorded. 🎉
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>When</th>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)', whiteSpace: 'nowrap' }}>
                        {fmtRel(r.createdAt)}
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{r.source}</td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>{r.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
