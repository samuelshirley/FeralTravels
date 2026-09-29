'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The deployment-wide Jev switch, and what Jev did with it.
 *
 * Same shape as `PaywallSwitch.tsx` — one tap, a ref re-entrancy guard,
 * `router.refresh()` after a flip, an inline error — because it is the same
 * kind of control: both directions are recoverable by pressing it again, and
 * OFF is exactly the app as it was before Jev existed.
 *
 * The rest is the three things the switch alone cannot tell you: whether Jev
 * is configured at all (ON with no config is Haiku for everyone, silently
 * otherwise), how many accounts ignore this switch, and whether Jev is earning
 * its place — settled vs passed on, failures, latency, and the Haiku spend it
 * avoided.
 *
 * Props are plain data. The types are declared here rather than imported from
 * `server/repos/jev.ts`, which is `server-only`.
 */

export interface JevConfigProps {
  configured: boolean;
  host: string | null;
  model: string | null;
  t1Min: number | null;
  timeoutMs: number | null;
  keySet: boolean;
  reason: string | null;
}

export interface JevStatsProps {
  days: number;
  calls: number;
  settled: number;
  passedToHaiku: number;
  errors: number;
  timeouts: number;
  p50Ms: number | null;
  p95Ms: number | null;
  classifierCallUsd: number;
  classifierCallSource: 'usage_events' | 'measured';
  classifierCallRows: number;
  avoidedUsd: number;
}

interface Props {
  on: boolean;
  config: JevConfigProps;
  /** Null when the read failed — said so, rather than rendered as zeros. */
  stats: JevStatsProps | null;
  overrides: { on: number; off: number } | null;
  /** Jev's margin rule, passed in so the line cannot drift from the code. */
  minMargin: number;
}

function usd(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

const line: React.CSSProperties = { margin: '6px 0 0', fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.6 };

export default function JevSwitch({ on, config, stats, overrides, minMargin }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function flip() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/jev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: on ? 'off' : 'on' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Could not change the Jev switch (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the Jev switch');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const overrideCount = overrides ? overrides.on + overrides.off : 0;

  return (
    <div data-testid="admin-jev">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Message classifier</h2>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => void flip()}
          disabled={busy}
          data-testid="admin-jev-switch"
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            padding: '3px 8px',
            borderRadius: 999,
            border: '1px solid var(--tp-border-strong)',
            background: 'transparent',
            color: on ? 'var(--tp-text)' : 'var(--tp-subtle)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'SWITCHING…' : on ? 'JEV FIRST' : 'HAIKU ONLY'}
        </button>
      </div>

      {config.configured ? (
        <p style={line} data-testid="admin-jev-config">
          Jev at <code>{config.host}</code> ({config.model}
          {config.keySet ? ', key set' : ', no key'}) settles a T1 at p ≥ {config.t1Min} leading
          by ≥ {minMargin}, within {config.timeoutMs} ms. Everything else goes to Haiku.
        </p>
      ) : (
        <p style={{ ...line, color: on ? 'var(--tp-danger)' : line.color }} data-testid="admin-jev-config">
          Jev is not configured: {config.reason}.
          {on ? ' The switch is on, and every message is still going to Haiku.' : ''}
        </p>
      )}

      {overrides === null ? (
        <p style={line}>Could not read the per-account overrides.</p>
      ) : overrideCount > 0 ? (
        <p style={line} data-testid="admin-jev-overrides">
          {overrides.on} account{overrides.on === 1 ? '' : 's'} forced to Jev and {overrides.off} to
          Haiku ignore this switch.
        </p>
      ) : null}

      {stats === null ? (
        <p style={{ ...line, color: 'var(--tp-danger)' }}>Could not read Jev&apos;s results.</p>
      ) : stats.calls === 0 ? (
        <p style={line} data-testid="admin-jev-stats">No Jev calls in the last {stats.days} days.</p>
      ) : (
        <p style={line} data-testid="admin-jev-stats">
          Last {stats.days} days: Jev settled <strong>{stats.settled}</strong> of {stats.calls} (
          {pct(stats.settled, stats.calls)}) and passed {stats.passedToHaiku} to Haiku
          {stats.errors > 0 ? `, ${stats.errors} of them on an error (${stats.timeouts} timeouts)` : ''}.
          {stats.p50Ms !== null && stats.p95Ms !== null
            ? ` Latency p50 ${stats.p50Ms} ms, p95 ${stats.p95Ms} ms.`
            : ''}{' '}
          About <strong>{usd(stats.avoidedUsd)}</strong> of Haiku avoided, at {usd(stats.classifierCallUsd)} a
          call ({stats.classifierCallSource === 'usage_events'
            ? `average of ${stats.classifierCallRows} classifier calls, 30 days`
            : 'measured 2026-09-09; no recent classifier calls to average'}
          ).
        </p>
      )}

      {error && (
        <p role="alert" style={{ ...line, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
