import { formatBreakerValue } from '@/server/payments';
import type { BreakerSnapshot } from '@/server/payments';

import { IP_LIMITS } from '@/lib/ipLimit';

import PennyLockSwitch from './PennyLockSwitch';

/**
 * What the whole app is spending, against the ceilings that stop it.
 *
 * Every other number on this dashboard is retrospective — what happened, whose
 * account, how much. This block is the only one that answers "is anything
 * being refused right now, and why", which is the question asked at the moment
 * somebody reports that Penny will not answer them.
 *
 * Nothing here is a new measurement. Every value is a query over rows the
 * breakers already read on every request; the block exists so the same facts
 * the gate acts on are the facts a human sees, rather than two implementations
 * of "how much have we spent" that can disagree.
 */

const labelRow: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.15em',
  color: 'var(--tp-subtle)',
  marginBottom: 6,
};

const LEVEL_COLOUR: Record<string, string> = {
  ok: 'var(--tp-subtle)',
  alert: '#b26a00',
  open: '#b3261e',
};

function Meter({
  label,
  value,
  alertAt,
  stopAt,
  level,
  window: windowLabel,
}: {
  label: string;
  value: string;
  alertAt: string;
  stopAt: string;
  level: string;
  window: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 1fr) auto auto',
        alignItems: 'baseline',
        gap: 10,
        padding: '8px 0',
        borderBottom: '1px solid var(--tp-border)',
      }}
    >
      <div>
        <div style={{ fontSize: 13, color: 'var(--tp-text)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>{windowLabel}</div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: LEVEL_COLOUR[level] ?? 'var(--tp-text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--tp-subtle)', whiteSpace: 'nowrap' }}>
        alert {alertAt} · stop {stopAt}
      </div>
    </div>
  );
}

export interface IpLimitHit {
  scope: string;
  ip: string;
  count: number;
  max: number;
}

export default function PennyLockdownBlock({
  snapshot,
  ipHits,
}: {
  snapshot: BreakerSnapshot;
  ipHits: IpLimitHit[];
}) {
  const { statuses, facts, worst } = snapshot;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Penny lockdown</h2>
        <span
          data-testid="admin-breaker-worst"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            padding: '3px 8px',
            borderRadius: 999,
            border: `1px solid ${LEVEL_COLOUR[worst] ?? 'var(--tp-border-strong)'}`,
            color: LEVEL_COLOUR[worst] ?? 'var(--tp-subtle)',
          }}
        >
          {worst === 'open' ? 'REFUSING' : worst === 'alert' ? 'OVER ALERT' : 'ALL CLEAR'}
        </span>
      </div>

      <p style={{ fontSize: 12, color: 'var(--tp-muted)', margin: '0 0 12px' }}>
        Global ceilings. Every other spend limit in the app is per-account, and an
        attacker chooses how many accounts they have — these bound the whole
        deployment, so the worst case of any attack is the stop line plus one
        30-second cache window per running instance. Admins are exempt from the
        stop, never from the accounting.
      </p>

      {facts.factsUnavailable ? (
        <p style={{ fontSize: 12, color: '#b3261e', margin: '0 0 12px' }}>
          These numbers could not be read. While that is true the gate REFUSES
          every non-admin request — it fails closed, deliberately.
        </p>
      ) : null}

      <div style={{ marginBottom: 14 }}>
        {statuses
          .filter((s) => s.id !== 'manual_lock')
          .map((s) => (
            <Meter
              key={s.id}
              label={s.label}
              value={formatBreakerValue(s)}
              alertAt={formatBreakerValue({ unit: s.unit, value: s.alertAt })}
              stopAt={
                s.stopAt === null
                  ? 'never'
                  : formatBreakerValue({ unit: s.unit, value: s.stopAt })
              }
              level={s.level}
              window={
                s.stopAt === null
                  ? `rolling ${s.windowHours}h · alert only`
                  : `rolling ${s.windowHours}h`
              }
            />
          ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={labelRow}>PER-IP LIMITS</div>
        <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginBottom: 6 }}>
          {IP_LIMITS.map((l) => `${l.label} ${l.max}/${l.windowHours}h`).join(' · ')} — per
          address. A hint, not an identity: a household shares one and an attacker has as many
          as they want, which is why the ceilings above are what actually bound the damage.
        </div>
        {ipHits.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--tp-muted)' }}>
            Nothing has hit a limit in the last 24 hours.
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--tp-text)' }}>
            {ipHits.map((h) => (
              <div key={`${h.scope}:${h.ip}`} style={{ padding: '3px 0' }}>
                <code style={{ fontSize: 11 }}>{h.ip}</code> — {h.scope} {h.count}/{h.max}
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--tp-muted)' }}>
          {facts.manualLock
            ? 'Penny is closed by hand. Only admins can plan anything.'
            : 'Penny is open.'}
        </div>
        <PennyLockSwitch locked={facts.manualLock} />
      </div>
    </div>
  );
}
