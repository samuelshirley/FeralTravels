import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { listDeletedAccounts } from '@/server/repos/accountDeletion';
import { isEmailEncryptionConfigured } from '@/server/deletedUserCrypto';
import AppNavbar from '@/components/AppNavbar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every account that has been deleted, newest first.
 *
 * The point of the page is churn: who signs up, how far they get, and how long
 * they last before quitting. `deleted_users` is the only trace a deleted account
 * leaves, and the addresses in it are AES-encrypted at rest — this page is the
 * one place they are decrypted, behind the same admin allowlist as the rest of
 * /admin.
 */
const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

const th: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--tp-subtle)',
  padding: '8px 10px',
  borderBottom: '1px solid var(--tp-border)',
  whiteSpace: 'nowrap',
};

const td: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--tp-text)',
  padding: '10px',
  borderBottom: '1px solid var(--tp-border)',
  verticalAlign: 'top',
};

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

/** Whole days between signup and deletion — the "how long did they last" number. */
function tenureDays(created: Date | null, deleted: Date): string {
  if (!created) return '—';
  const ms = new Date(deleted).getTime() - new Date(created).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const days = Math.floor(ms / 86_400_000);
  return days === 0 ? 'same day' : `${days}d`;
}

export default async function AdminDeletedAccountsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await listDeletedAccounts();
  const keyConfigured = isEmailEncryptionConfigured();

  // "Deleted without ever planning a trip" is the number that says whether
  // people are bouncing off onboarding rather than off the product.
  const neverPlanned = rows.filter((r) => r.tripCount === 0).length;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppNavbar
        user={{ name: session.user.name, email: session.user.email, image: session.user.image }}
        isAdmin
      />
      <div style={{ flex: 1, maxWidth: 1000, width: '100%', margin: '0 auto', padding: '32px 16px 80px', boxSizing: 'border-box' }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 26, fontWeight: 700, color: 'var(--tp-text)' }}>
          Deleted accounts
        </h1>
        <p style={{ margin: 0, marginBottom: 20, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
          {rows.length} deletion{rows.length === 1 ? '' : 's'} recorded
          {rows.length > 0 && <> · {neverPlanned} never planned a trip</>}. Every other trace of
          these accounts is gone — this table is all that survives.
        </p>

        {!keyConfigured && (
          <div
            style={{
              ...card,
              background: 'var(--tp-danger-muted)',
              borderColor: 'rgba(198, 93, 74, 0.4)',
              marginBottom: 16,
              fontSize: 13,
              color: 'var(--tp-text)',
            }}
          >
            <strong>DELETED_USER_ENC_KEY is not set.</strong> Deletions still work and are still
            counted, but addresses cannot be shown — new rows store only the irreversible hash.
            Set a 32-byte key (base64 or hex) in the Vercel environment to record readable
            addresses going forward. Rows written without it can never be recovered.
          </div>
        )}

        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Email</th>
                <th style={th}>Sign-in</th>
                <th style={th}>Joined</th>
                <th style={th}>Deleted</th>
                <th style={th}>Lasted</th>
                <th style={th}>Trips</th>
                <th style={th}>Vehicles</th>
                <th style={th}>Msgs</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td style={{ ...td, color: 'var(--tp-muted)' }} colSpan={8}>
                    Nobody has deleted their account yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={td}>
                    {r.email ?? (
                      <span
                        title={`SHA-256: ${r.emailHash}`}
                        style={{ color: 'var(--tp-subtle)', fontStyle: 'italic' }}
                      >
                        not recoverable
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: 'var(--tp-muted)' }}>
                    {r.signInProviders.join(', ') || '—'}
                  </td>
                  <td style={{ ...td, color: 'var(--tp-muted)' }}>{fmtDate(r.accountCreatedAt)}</td>
                  <td style={{ ...td, color: 'var(--tp-muted)' }}>{fmtDate(r.deletedAt)}</td>
                  <td style={td}>{tenureDays(r.accountCreatedAt, r.deletedAt)}</td>
                  <td style={td}>{r.tripCount}</td>
                  <td style={td}>{r.vehicleCount}</td>
                  <td style={td}>{r.chatMessageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
