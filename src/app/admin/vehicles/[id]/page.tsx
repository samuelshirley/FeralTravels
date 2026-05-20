import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import { getAdminVehicleById } from '@/server/repos/admin';
import AppNavbar from '@/components/AppNavbar';
import styles from '../../admin.module.css';
import {
  buildVehicleProfileQuestions,
  formatVehicleProfileFieldDisplay,
  vehicleProfileFieldHasValue,
  type VehicleProfileQuestion,
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

type AdminVehicleRow = NonNullable<Awaited<ReturnType<typeof getAdminVehicleById>>>;

function rawValueForField(key: string, row: AdminVehicleRow): unknown {
  switch (key) {
    case 'name':
      return row.name;
    case 'refill_distance_km':
      return row.refillDistanceKm;
    case 'max_drive_hours_per_day':
      return row.maxDriveHoursPerDay;
    case 'max_drive_hours_per_week':
      return row.maxDriveHoursPerWeek;
    case 'max_consecutive_drive_days':
      return row.maxConsecutiveDriveDays;
    case 'water_refill_days':
      return row.waterRefillDays;
    case 'blackwater_refill_days':
      return row.blackwaterRefillDays;
    default:
      return null;
  }
}

/**
 * `formatVehicleProfileFieldDisplay` expects refill distance in the owner's
 * display unit (mi or km), not stored km.
 */
function displayValueForQuestion(row: AdminVehicleRow, q: VehicleProfileQuestion, units: UnitsPref): unknown {
  const raw = rawValueForField(q.key, row);
  if (q.key === 'refill_distance_km' && raw != null && typeof raw === 'number') {
    if (units === 'imperial') {
      const mi = kmToMi(raw);
      return mi == null ? null : Math.round(mi);
    }
    return raw;
  }
  return raw;
}

interface PageProps {
  params: { id: string };
}

export default async function AdminVehicleDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const vehicleId = params.id;

  const row = await getAdminVehicleById(vehicleId);
  if (!row) notFound();

  const units = asUnitsPref(row.userUnitsPref);
  const questions = buildVehicleProfileQuestions(units);
  const vehicleRecord = Object.fromEntries(
    questions.map((q) => [q.key, rawValueForField(q.key, row)])
  ) as Record<string, unknown>;

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
          <Link href="/admin/vehicles" style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}>
            Vehicles
          </Link>
          {' / '}
          <span>{row.name}</span>
        </nav>

        <header style={{ marginBottom: 24 }}>
          <div style={labelStyle}>VEHICLE</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>{row.name}</h1>
          <div style={{ fontSize: 13, color: 'var(--tp-muted)', marginTop: 8 }}>
            Owner:{' '}
            <Link href={`/admin/users/${row.userId}`} style={{ color: 'var(--tp-primary)' }}>
              {row.userName || row.userEmail || row.userId}
            </Link>
            {row.isDefault && (
              <span
                style={{
                  marginLeft: 12,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--tp-success)',
                }}
              >
                DEFAULT
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tp-subtle)', marginTop: 6 }}>
            Updated {fmtAbs(row.updatedAt)} ({fmtRel(row.updatedAt)}) · Owner units:{' '}
            {row.userUnitsPref ?? '— (not set)'}
          </div>
        </header>

        <section style={card}>
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>Profile fields</h2>
          <p
            style={{
              margin: '0 0 16px',
              fontSize: 12,
              color: 'var(--tp-muted)',
            }}
          >
            Same questions as trip onboarding and Settings. Optional fields may be empty.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {questions.map((q) => {
              const filled = vehicleProfileFieldHasValue(vehicleRecord, q);
              const value = displayValueForQuestion(row, q, units);
              const text = formatVehicleProfileFieldDisplay(q, value, units);
              return (
                <div
                  key={q.key}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--tp-border)',
                    background: 'var(--tp-surface-muted)',
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, flex: '1 1 200px' }}>{q.label}</span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: filled ? 'var(--tp-success)' : 'var(--tp-muted)',
                      }}
                    >
                      {q.optional
                        ? filled
                          ? 'FILLED'
                          : 'OPTIONAL · NOT SET'
                        : filled
                          ? 'FILLED'
                          : 'NOT SET'}
                    </span>
                  </div>
                  {q.help && (
                    <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>{q.help}</div>
                  )}
                  <div
                    style={{
                      fontSize: 13,
                      color: filled ? 'var(--tp-text)' : 'var(--tp-subtle)',
                      marginTop: 8,
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {text}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--tp-subtle)', marginTop: 4 }}>
                    key: <code>{q.key}</code>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
