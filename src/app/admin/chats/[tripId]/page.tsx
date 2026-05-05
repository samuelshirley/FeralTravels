import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getChatForTrip } from '@/server/repos/admin';
import AppNavbar from '@/components/AppNavbar';
import styles from '../../admin.module.css';
import ChangesToggle from './ChangesToggle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtAbs(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 19).replace('T', ' ');
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

interface PageProps {
  params: { tripId: string };
}

interface RoleStyle {
  label: string;
  bg: string;
  fg: string;
}

const ROLE_STYLES: Record<string, RoleStyle> = {
  user: {
    label: 'User',
    bg: 'var(--tp-primary-muted)',
    fg: 'var(--tp-primary)',
  },
  assistant: {
    label: 'Assistant',
    bg: 'var(--tp-success-muted)',
    fg: 'var(--tp-success)',
  },
};

const KIND_LABELS: Record<string, string> = {
  ai: 'AI',
  form_question: 'Onboarding question',
  form_answer: 'Onboarding answer',
};

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export default async function AdminChatViewerPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const tripId = parseInt(params.tripId, 10);
  if (!Number.isFinite(tripId)) notFound();

  const data = await getChatForTrip(tripId);
  if (!data) notFound();

  const { trip, messages } = data;

  // Quick stats: counts by role/kind, edits, span.
  const counts = messages.reduce(
    (acc, m) => {
      acc.total += 1;
      if (m.role === 'user') acc.user += 1;
      if (m.role === 'assistant') acc.assistant += 1;
      if (m.changesMade) acc.edits += 1;
      return acc;
    },
    { total: 0, user: 0, assistant: 0, edits: 0 }
  );

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
          {trip.userId ? (
            <Link
              href={`/admin/users/${trip.userId}`}
              style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
            >
              {trip.userName || trip.userEmail || trip.userId}
            </Link>
          ) : (
            <span>(orphan trip)</span>
          )}
          {' / '}
          <span>chat #{trip.id}</span>
        </nav>

        <header style={{ marginBottom: 20 }}>
          <div style={labelStyle}>READ-ONLY CHAT</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>
            {trip.name}
          </h1>
          <div
            style={{
              display: 'flex',
              gap: 16,
              marginTop: 6,
              flexWrap: 'wrap',
              fontSize: 12,
              color: 'var(--tp-muted)',
            }}
          >
            <span>
              owner:{' '}
              {trip.userId ? (
                <Link
                  href={`/admin/users/${trip.userId}`}
                  style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                >
                  {trip.userName || trip.userEmail || trip.userId}
                </Link>
              ) : (
                '(orphan)'
              )}
            </span>
            <span>status: {trip.status}</span>
            {trip.isTemplate && <span style={{ color: 'var(--tp-gold)' }}>TEMPLATE</span>}
            <Link
              href={`/trips/${trip.id}`}
              style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
            >
              Open trip editor →
            </Link>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              marginTop: 6,
              flexWrap: 'wrap',
              fontSize: 11,
              color: 'var(--tp-subtle)',
            }}
          >
            <span>{counts.total} messages</span>
            <span>{counts.user} user / {counts.assistant} assistant</span>
            <span>{counts.edits} produced edits</span>
          </div>
        </header>

        {messages.length === 0 ? (
          <div style={{ ...card, fontSize: 13, color: 'var(--tp-subtle)' }}>
            No messages on this trip yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m) => {
              const roleStyle = ROLE_STYLES[m.role] ?? {
                label: m.role,
                bg: 'var(--tp-surface-muted)',
                fg: 'var(--tp-muted)',
              };
              const kindLabel = KIND_LABELS[m.kind] ?? m.kind;
              return (
                <article
                  key={m.id}
                  style={{
                    ...card,
                    padding: 14,
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{
                        background: roleStyle.bg,
                        color: roleStyle.fg,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        padding: '2px 8px',
                        borderRadius: 4,
                        textTransform: 'uppercase',
                      }}
                    >
                      {roleStyle.label}
                    </span>
                    {m.kind !== 'ai' && (
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--tp-muted)',
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {kindLabel}
                      </span>
                    )}
                    {m.changesMade && (
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--tp-success)',
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                        }}
                      >
                        ✓ APPLIED EDIT
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <time
                      style={{
                        fontSize: 10,
                        color: 'var(--tp-subtle)',
                        fontFamily: 'monospace',
                      }}
                      title={fmtAbs(m.createdAt)}
                    >
                      {fmtRel(m.createdAt)} · {fmtAbs(m.createdAt)}
                    </time>
                  </header>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--tp-text)',
                      lineHeight: 1.55,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {m.content}
                  </div>
                  {m.changesMade && (
                    <ChangesToggle pretty={prettyJson(m.changesMade)} />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
