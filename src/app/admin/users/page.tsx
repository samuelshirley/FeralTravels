import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listAllUsers, type UserSort } from '@/server/repos/admin';
import AppNavbar from '@/components/AppNavbar';
import styles from '../admin.module.css';
import { requireWebAccess } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAGE_SIZE = 20;

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

const tdStyle: React.CSSProperties = {
  padding: '10px 10px',
  borderBottom: '1px solid var(--tp-border)',
  fontSize: 13,
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
    sort?: string;
  };
}

const VALID_SORTS: UserSort[] = ['joined_desc', 'joined_asc', 'name_asc', 'name_desc'];

function parseSort(s: string | undefined): UserSort {
  return VALID_SORTS.includes(s as UserSort) ? (s as UserSort) : 'joined_desc';
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Middleware turns away browsers with no session; this is the half that
  // needs a database to tell whose session it is. Guarded by
  // webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const search = searchParams.q?.trim() || '';
  const sort = parseSort(searchParams.sort);
  const offset = (page - 1) * PAGE_SIZE;

  const result = await listAllUsers({
    offset,
    limit: PAGE_SIZE,
    search: search || null,
    sort,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const startN = result.total === 0 ? 0 : offset + 1;
  const endN = Math.min(offset + result.rows.length, result.total);

  // Build URLs for sort + pagination preserving the other params.
  function url(overrides: Partial<{ page: number; q: string; sort: UserSort }>): string {
    const params = new URLSearchParams();
    const nextPage = overrides.page ?? page;
    const nextQ = overrides.q ?? search;
    const nextSort = overrides.sort ?? sort;
    if (nextPage > 1) params.set('page', String(nextPage));
    if (nextQ) params.set('q', nextQ);
    if (nextSort !== 'joined_desc') params.set('sort', nextSort);
    const qs = params.toString();
    return qs ? `/admin/users?${qs}` : '/admin/users';
  }

  function sortHeader(label: string, asc: UserSort, desc: UserSort) {
    const isAscActive = sort === asc;
    const isDescActive = sort === desc;
    const next = isDescActive ? asc : desc;
    const arrow = isAscActive ? ' ↑' : isDescActive ? ' ↓' : '';
    return (
      <Link
        href={url({ sort: next, page: 1 })}
        style={{
          ...thStyle,
          display: 'inline-block',
          color: isAscActive || isDescActive ? 'var(--tp-text)' : 'var(--tp-muted)',
          textDecoration: 'none',
        }}
      >
        {label}
        {arrow}
      </Link>
    );
  }

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
          {' / '}Users
        </nav>

        <header style={{ marginBottom: 20 }}>
          <div style={labelStyle}>SYSTEM</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
            Users
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
        </header>

        {/* Search bar — plain GET form, no JS. */}
        <form
          method="GET"
          action="/admin/users"
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="Search by name or email…"
            style={{
              flex: '1 1 240px',
              padding: '8px 12px',
              fontSize: 13,
              border: '1px solid var(--tp-border)',
              borderRadius: 6,
              background: 'var(--tp-surface)',
              color: 'var(--tp-text)',
            }}
          />
          {sort !== 'joined_desc' && <input type="hidden" name="sort" value={sort} />}
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
            }}
          >
            Search
          </button>
          {search && (
            <Link
              href="/admin/users"
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--tp-muted)',
                textDecoration: 'none',
                border: '1px solid var(--tp-border)',
                borderRadius: 6,
              }}
            >
              Clear
            </Link>
          )}
        </form>

        <section style={card}>
          {result.rows.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--tp-subtle)', padding: '8px 4px' }}>
              {search ? `No users match "${search}".` : 'No users yet.'}
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>{sortHeader('User', 'name_asc', 'name_desc')}</th>
                    <th style={thStyle}>Email</th>
                    <th style={thStyle}>{sortHeader('Joined', 'joined_asc', 'joined_desc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((u) => (
                    <tr key={u.id} className={styles.rowLink}>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          style={{
                            color: 'inherit',
                            textDecoration: 'none',
                            fontWeight: 600,
                            display: 'block',
                          }}
                        >
                          {u.name || '—'}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {u.email || '—'}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/users/${u.id}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {fmtRel(u.createdAt)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
