import Link from 'next/link';
import { fmtAgo } from '../tiles';
import styles from '../admin.module.css';

export type SignupEntitlement =
  | {
      ok: true;
      state: string;
      entitled: boolean;
      /** Whether the paywall is on — off means the state is tracked but not enforced. */
      enforced: boolean;
      trialEndsAt: Date | null;
    }
  | { ok: false; error: string };

export interface SignupRow {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
  lastActiveAt: Date | null;
  tripCount: number;
  entitlement: SignupEntitlement;
}

function fmtWhen(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function EntitlementCell({ e, now }: { e: SignupEntitlement; now: Date }) {
  if (!e.ok) return <span className={styles.danger}>read failed: {e.error}</span>;
  const trial =
    e.trialEndsAt && e.trialEndsAt.getTime() > now.getTime()
      ? `trial ends in ${Math.ceil((e.trialEndsAt.getTime() - now.getTime()) / 86_400_000)}d`
      : null;
  return (
    <>
      <span className={styles.badge}>{e.state}</span>
      <div className={styles.subtle}>
        {e.entitled ? 'has access' : 'blocked'}
        {trial ? ` · ${trial}` : ''}
        {!e.enforced ? ' · paywall off' : ''}
      </div>
    </>
  );
}

/**
 * New signups for one window: who joined, whether they came back, whether they
 * made a trip, and where they stand with the paywall — the four facts that say
 * whether a signup is turning into a user.
 */
export default function SignupsTable({ rows, now }: { rows: SignupRow[]; now: Date }) {
  if (rows.length === 0) return <div className={styles.empty}>No signups in this window.</div>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} data-testid="signups-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Joined</th>
            <th>Last active</th>
            <th className={styles.num}>Trips</th>
            <th>Entitlement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={styles.rowLink} data-testid="signup-row">
              <td>
                <Link href={`/admin/users/${r.id}`} className={styles.cellLink}>
                  <div className={styles.strong}>{r.name || r.email || '(no name)'}</div>
                  {r.name && r.email && <div className={styles.subtle}>{r.email}</div>}
                </Link>
              </td>
              <td title={fmtWhen(r.createdAt)}>{fmtAgo(r.createdAt, now)}</td>
              <td className={r.lastActiveAt ? undefined : styles.muted} title={r.lastActiveAt ? fmtWhen(r.lastActiveAt) : undefined}>
                {r.lastActiveAt ? fmtAgo(r.lastActiveAt, now) : 'no activity yet'}
              </td>
              <td className={styles.num}>{r.tripCount}</td>
              <td>
                <EntitlementCell e={r.entitlement} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
