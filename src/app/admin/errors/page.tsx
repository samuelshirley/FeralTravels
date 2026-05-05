import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listErrors, listErrorProviders } from '@/server/repos/admin';
import AppNavbar from '@/components/AppNavbar';
import AdminErrorLog from '../AdminErrorLog';
import styles from '../admin.module.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAGE_SIZE = 20;

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

interface PageProps {
  // Next 14 — searchParams is a plain object, not a Promise.
  searchParams: {
    page?: string;
    q?: string;
    /** Comma-separated provider names. */
    provider?: string;
    /** ISO date or N-day shorthand: '24h' | '7d' | '30d' | '' */
    since?: string;
    userId?: string;
  };
}

function parseSince(s: string | undefined): Date | null {
  if (!s) return null;
  if (s === '24h') return new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (s === '7d') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (s === '30d') return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export default async function AdminErrorsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const search = searchParams.q?.trim() || '';
  const providers = searchParams.provider
    ? searchParams.provider.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const sinceParam = searchParams.since ?? '';
  const since = parseSince(sinceParam);
  const userIdFilter = searchParams.userId?.trim() || null;

  const offset = (page - 1) * PAGE_SIZE;

  const [result, allProviders] = await Promise.all([
    listErrors({
      offset,
      limit: PAGE_SIZE,
      providers: providers.length > 0 ? providers : null,
      search: search || null,
      since,
      userId: userIdFilter,
    }),
    listErrorProviders(),
  ]);

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const startN = result.total === 0 ? 0 : offset + 1;
  const endN = Math.min(offset + result.rows.length, result.total);

  function url(overrides: Partial<{
    page: number;
    q: string;
    provider: string[];
    since: string;
    userId: string | null;
  }>): string {
    const params = new URLSearchParams();
    const nextPage = overrides.page ?? page;
    const nextQ = overrides.q ?? search;
    const nextProviders = overrides.provider ?? providers;
    const nextSince = overrides.since ?? sinceParam;
    const nextUserId = overrides.userId !== undefined ? overrides.userId : userIdFilter;
    if (nextPage > 1) params.set('page', String(nextPage));
    if (nextQ) params.set('q', nextQ);
    if (nextProviders.length > 0) params.set('provider', nextProviders.join(','));
    if (nextSince) params.set('since', nextSince);
    if (nextUserId) params.set('userId', nextUserId);
    const qs = params.toString();
    return qs ? `/admin/errors?${qs}` : '/admin/errors';
  }

  // For the time-window pills.
  const sinceOptions: Array<{ value: string; label: string }> = [
    { value: '', label: 'All time' },
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
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
          {' / '}Errors
        </nav>

        <header style={{ marginBottom: 20 }}>
          <div style={labelStyle}>SYSTEM</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
            API failures
            <span
              style={{
                marginLeft: 12,
                fontSize: 14,
                color: 'var(--tp-subtle)',
                fontWeight: 500,
              }}
            >
              {result.total.toLocaleString()} total
            </span>
          </h1>
          <p
            style={{
              fontSize: 12,
              color: 'var(--tp-subtle)',
              marginTop: 6,
              maxWidth: 720,
              lineHeight: 1.5,
            }}
          >
            Rows from <code>usage_events</code> where <code>success = false</code>. These are
            failed external API calls (Anthropic, Google, iOverlander, etc.) — not user-facing
            JS errors or HTTP 5xx from our own routes.
          </p>
        </header>

        {/* Filter form */}
        <form
          method="GET"
          action="/admin/errors"
          style={{
            ...card,
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            marginBottom: 16,
          }}
        >
          <div style={{ flex: '1 1 240px' }}>
            <div style={{ ...labelStyle, marginBottom: 4 }}>SEARCH MESSAGE</div>
            <input
              type="text"
              name="q"
              defaultValue={search}
              placeholder="HTTP 406, REQUEST_DENIED, …"
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 13,
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
                background: 'var(--tp-surface)',
                color: 'var(--tp-text)',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ flex: '0 1 220px' }}>
            <div style={{ ...labelStyle, marginBottom: 4 }}>PROVIDER</div>
            <select
              name="provider"
              defaultValue={providers[0] ?? ''}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 13,
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
                background: 'var(--tp-surface)',
                color: 'var(--tp-text)',
              }}
            >
              <option value="">All providers</option>
              {allProviders.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 1 180px' }}>
            <div style={{ ...labelStyle, marginBottom: 4 }}>WINDOW</div>
            <select
              name="since"
              defaultValue={sinceParam}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 13,
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
                background: 'var(--tp-surface)',
                color: 'var(--tp-text)',
              }}
            >
              {sinceOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {userIdFilter && (
            <input type="hidden" name="userId" value={userIdFilter} />
          )}
          <button
            type="submit"
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              background: 'var(--tp-primary)',
              color: 'var(--tp-on-primary)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              alignSelf: 'flex-end',
            }}
          >
            Apply
          </button>
          {(search || providers.length > 0 || sinceParam || userIdFilter) && (
            <Link
              href="/admin/errors"
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--tp-muted)',
                textDecoration: 'none',
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
                alignSelf: 'flex-end',
              }}
            >
              Clear
            </Link>
          )}
        </form>

        {userIdFilter && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--tp-muted)',
              marginBottom: 12,
              padding: '8px 12px',
              background: 'var(--tp-primary-muted)',
              borderRadius: 6,
            }}
          >
            Filtered to user{' '}
            <Link
              href={`/admin/users/${userIdFilter}`}
              style={{ color: 'var(--tp-primary)', textDecoration: 'none', fontWeight: 600 }}
            >
              {userIdFilter}
            </Link>
            {' '}—{' '}
            <Link href={url({ userId: null, page: 1 })} className={styles.seeAllLink}>
              clear user filter
            </Link>
          </div>
        )}

        <section style={{ ...card, marginBottom: 16 }}>
          <AdminErrorLog
            rows={result.rows.map((e) => ({
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

        {/* Pagination */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16,
            fontSize: 12,
            color: 'var(--tp-muted)',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            {result.total === 0
              ? 'No results'
              : `Showing ${startN}–${endN} of ${result.total.toLocaleString()}`}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {page > 1 ? (
              <Link href={url({ page: page - 1 })} className={styles.seeAllLink}>
                ← Prev
              </Link>
            ) : (
              <span style={{ color: 'var(--tp-subtle)' }}>← Prev</span>
            )}
            <span>
              Page {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={url({ page: page + 1 })} className={styles.seeAllLink}>
                Next →
              </Link>
            ) : (
              <span style={{ color: 'var(--tp-subtle)' }}>Next →</span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
