import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAdminVehiclesOverview, type AdminVehicleListRow } from '@/server/repos/admin';
import AppNavbar from '@/components/AppNavbar';
import styles from '../admin.module.css';
import {
  vehicleProfileRequiredCompletion,
} from '@/lib/vehicleProfile';
import { kmToMi, asUnitsPref, type UnitsPref } from '@/lib/units';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtRel(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function rowToProfileRecord(row: AdminVehicleListRow): Record<string, unknown> {
  return {
    name: row.name,
    refill_distance_km: row.refillDistanceKm,
    max_drive_hours_per_day: row.maxDriveHoursPerDay,
    max_drive_hours_per_week: row.maxDriveHoursPerWeek,
    max_consecutive_drive_days: row.maxConsecutiveDriveDays,
    water_refill_days: row.waterRefillDays,
    blackwater_refill_days: row.blackwaterRefillDays,
    water_tracking_enabled: row.waterTrackingEnabled,
  };
}

function refillSummary(km: number | null, unitsPref: string | null): string {
  if (km == null) return '—';
  const u = asUnitsPref(unitsPref);
  if (u === 'imperial') {
    const mi = kmToMi(km);
    return mi == null ? '—' : `~${Math.round(mi)} mi`;
  }
  return `~${km} km`;
}

function driveSummary(row: AdminVehicleListRow): string {
  const parts: string[] = [];
  if (row.maxDriveHoursPerDay != null) parts.push(`${row.maxDriveHoursPerDay}h/d`);
  if (row.maxDriveHoursPerWeek != null) parts.push(`${row.maxDriveHoursPerWeek}h/wk`);
  if (row.maxConsecutiveDriveDays != null) parts.push(`${row.maxConsecutiveDriveDays}d max`);
  return parts.length ? parts.join(' · ') : '—';
}

const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
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

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.15em',
  color: 'var(--tp-subtle)',
  marginBottom: 6,
};

export default async function AdminVehiclesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const rows = await getAdminVehiclesOverview();

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
          <span>Vehicles</span>
        </nav>

        <header style={{ marginBottom: 24 }}>
          <div style={labelStyle}>FLEET</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Vehicles</h1>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--tp-muted)' }}>
            All user vehicles (newest updates first). Required profile fields:{' '}
            {vehicleProfileRequiredCompletion({}).total} per schema.
          </p>
        </header>

        <section style={card}>
          <div className={`${styles.tableScroll} ${styles.desktopOnly}`}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Vehicle</th>
                  <th style={thStyle}>Owner</th>
                  <th style={thStyle}>Refuel</th>
                  <th style={thStyle}>Drive limits</th>
                  <th style={thStyle}>Profile</th>
                  <th style={thStyle}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const comp = vehicleProfileRequiredCompletion(rowToProfileRecord(row));
                  return (
                    <tr key={row.vehicleId} className={styles.rowLink}>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/vehicles/${row.vehicleId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          <strong>{row.name}</strong>
                          {row.isDefault && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: '0.08em',
                                color: 'var(--tp-success)',
                              }}
                            >
                              DEFAULT
                            </span>
                          )}
                        </Link>
                      </td>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/users/${row.userId}`}
                          style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                        >
                          {row.userName || row.userEmail || row.userId}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/vehicles/${row.vehicleId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {refillSummary(row.refillDistanceKm, row.userUnitsPref)}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/vehicles/${row.vehicleId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {driveSummary(row)}
                        </Link>
                      </td>
                      <td style={tdStyle}>
                        <Link
                          href={`/admin/vehicles/${row.vehicleId}`}
                          style={{ color: 'inherit', textDecoration: 'none', fontWeight: 600 }}
                        >
                          {comp.filled}/{comp.total}
                        </Link>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--tp-muted)' }}>
                        <Link
                          href={`/admin/vehicles/${row.vehicleId}`}
                          style={{ color: 'inherit', textDecoration: 'none' }}
                        >
                          {fmtRel(row.updatedAt)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ ...tdStyle, color: 'var(--tp-subtle)' }}>
                      No vehicles.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className={styles.mobileOnly}>
            {rows.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
                No vehicles.
              </div>
            ) : (
              rows.map((row) => {
                const comp = vehicleProfileRequiredCompletion(rowToProfileRecord(row));
                return (
                  <Link
                    key={row.vehicleId}
                    href={`/admin/vehicles/${row.vehicleId}`}
                    className={styles.mobileRowCard}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 14 }}>{row.name}</strong>
                      {row.isDefault && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--tp-success)' }}>
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--tp-muted)', marginTop: 4 }}>
                      {row.userName || row.userEmail || 'User'}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--tp-muted)',
                        marginTop: 8,
                        lineHeight: 1.4,
                      }}
                    >
                      {refillSummary(row.refillDistanceKm, row.userUnitsPref)} · {driveSummary(row)}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--tp-subtle)',
                        marginTop: 6,
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>
                        Profile {comp.filled}/{comp.total}
                      </span>
                      <span>{fmtRel(row.updatedAt)}</span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
