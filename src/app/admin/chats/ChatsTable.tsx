import Link from 'next/link';
import { fmtAgo } from '../tiles';
import styles from '../admin.module.css';

export interface ChatRow {
  id: number | string;
  tripId: string;
  tripName: string | null;
  userEmail: string | null;
  role: string;
  content: string;
  hasChanges: boolean;
  createdAt: Date;
}

/** The newest chat messages across every trip; a row opens that trip's full conversation. */
export default function ChatsTable({ rows, now }: { rows: ChatRow[]; now: Date }) {
  if (rows.length === 0) return <div className={styles.empty}>No chat activity yet.</div>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} data-testid="chats-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Trip</th>
            <th>Role</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className={styles.rowLink} data-testid="chat-row">
              <td className={styles.muted}>{fmtAgo(m.createdAt, now)}</td>
              <td>
                <Link href={`/admin/chats/${m.tripId}`} className={styles.cellLink}>
                  <div className={styles.strong}>{m.tripName ?? `#${m.tripId.slice(0, 8)}`}</div>
                  {m.userEmail && <div className={styles.subtle}>{m.userEmail}</div>}
                </Link>
              </td>
              <td className={styles.muted}>
                {m.role}
                {m.hasChanges && <span className={styles.badge}> edited plan</span>}
              </td>
              <td>
                <Link href={`/admin/chats/${m.tripId}`} className={styles.cellLink}>
                  {m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
