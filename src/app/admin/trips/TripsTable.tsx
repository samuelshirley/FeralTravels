import Link from 'next/link';
import { fmtAgo } from '../tiles';
import styles from '../admin.module.css';

export interface TripRow {
  id: string;
  name: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  legCount: number;
  startDateParsed: string | null;
  updatedAt: Date;
}

/** Every non-template trip, most recently touched first. A row opens the trip's chat. */
export default function TripsTable({ rows, now }: { rows: TripRow[]; now: Date }) {
  if (rows.length === 0) return <div className={styles.empty}>No trips yet.</div>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} data-testid="trips-table">
        <thead>
          <tr>
            <th>Trip</th>
            <th>Owner</th>
            <th className={styles.num}>Legs</th>
            <th>Starts</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={styles.rowLink} data-testid="trip-row">
              <td>
                <Link href={`/admin/chats/${t.id}`} className={styles.cellLink}>
                  <span className={styles.strong}>{t.name}</span>
                </Link>
              </td>
              <td>
                {t.userId ? (
                  <Link href={`/admin/users/${t.userId}`} className={styles.cellLink}>
                    {t.userName || t.userEmail || '(no name)'}
                  </Link>
                ) : (
                  <span className={styles.muted}>(deleted user)</span>
                )}
              </td>
              <td className={styles.num}>{t.legCount}</td>
              <td className={styles.muted}>{t.startDateParsed ?? '—'}</td>
              <td className={styles.muted}>{fmtAgo(t.updatedAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
