'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The deployment-wide Jev switch, and what Jev did with it.
 *
 * Same shape as `PaywallSwitch.tsx` — one tap, a ref re-entrancy guard,
 * `router.refresh()` after a flip, an inline error — because it is the same
 * kind of control: every mode is recoverable by pressing another, and HAIKU
 * ONLY is exactly the app as it was before Jev existed. Three modes, so three
 * pills in a radiogroup rather than one toggle.
 *
 * The rest is what the switch alone cannot tell you: whether Jev is
 * configured at all (a mode with no config is Haiku for everyone, silently
 * otherwise), how many accounts ignore this switch, whether Jev-first is
 * earning its place — settled vs passed on, failures, latency, the Haiku spend
 * it avoided — and, from compare mode, whether it would be SAFE: how often Jev
 * would have let through a message Haiku refused.
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

export type JevModeProp = 'off' | 'compare' | 'on';
type Tier = 'T1' | 'T2' | 'T3';

export interface JevCompareProps {
  days: number;
  compared: number;
  answered: number;
  errors: number;
  timeouts: number;
  agreed: number;
  matrix: Record<Tier, Record<Tier, number>>;
  wouldSettle: number;
  wouldPassHaikuRefused: number;
  wouldPassHaikuT2: number;
  wouldPassHaikuT3: number;
  haikuT1: number;
  haikuT1WouldSettle: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface Props {
  mode: JevModeProp;
  config: JevConfigProps;
  /** Null when the read failed — said so, rather than rendered as zeros. */
  stats: JevStatsProps | null;
  /** Null when the read failed. */
  compare: JevCompareProps | null;
  overrides: Record<JevModeProp, number> | null;
  /** Jev's margin rule, passed in so the line cannot drift from the code. */
  minMargin: number;
}

const MODES: Array<{ value: JevModeProp; label: string }> = [
  { value: 'off', label: 'HAIKU ONLY' },
  { value: 'compare', label: 'COMPARE' },
  { value: 'on', label: 'JEV FIRST' },
];

const TIERS: Tier[] = ['T1', 'T2', 'T3'];

function usd(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

const line: React.CSSProperties = { margin: '6px 0 0', fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.6 };

/**
 * Compare mode's week: Haiku decided every one of these messages, and Jev was
 * asked the same question alongside. The headline is the only number that
 * says whether Jev-first is safe; coverage is what it would save.
 */
export function JevCompareSection({ compare, show }: { compare: JevCompareProps | null; show: boolean }) {
  if (compare === null) {
    return <p style={{ ...line, color: 'var(--tp-danger)' }}>Could not read the comparison.</p>;
  }
  if (compare.compared === 0) {
    return show ? (
      <p style={line} data-testid="admin-jev-compare">
        No messages compared in the last {compare.days} days.
      </p>
    ) : null;
  }
  const c = compare;
  const cell: React.CSSProperties = { padding: '2px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  return (
    <div data-testid="admin-jev-compare" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--tp-border)' }}>
      <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>Compare, last {c.days} days</h3>
      <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.5 }} data-testid="admin-jev-compare-headline">
        Jev would have passed, Haiku refused:{' '}
        <strong style={{ fontSize: 22, color: c.wouldPassHaikuRefused > 0 ? 'var(--tp-danger)' : 'var(--tp-text)' }}>
          {c.wouldPassHaikuRefused}
        </strong>{' '}
        of {c.wouldSettle} Jev-first would have settled ({pct(c.wouldPassHaikuRefused, c.wouldSettle)})
        {c.wouldPassHaikuRefused > 0 ? ` — ${c.wouldPassHaikuT2} T2, ${c.wouldPassHaikuT3} T3` : ''}.
      </p>
      <p style={line} data-testid="admin-jev-compare-summary">
        {c.compared} compared; Jev answered {c.answered}
        {c.errors > 0 ? ` (${c.errors} errors, ${c.timeouts} timeouts)` : ''} and agreed with Haiku on{' '}
        {c.agreed} ({pct(c.agreed, c.answered)}). Coverage: Jev-first would have skipped Haiku on{' '}
        {c.haikuT1WouldSettle} of {c.haikuT1} Haiku T1s ({pct(c.haikuT1WouldSettle, c.haikuT1)}).
        {c.p50Ms !== null && c.p95Ms !== null ? ` Jev p50 ${c.p50Ms} ms, p95 ${c.p95Ms} ms.` : ''}
      </p>
      <table style={{ marginTop: 8, fontSize: 12, borderCollapse: 'collapse' }} data-testid="admin-jev-compare-matrix">
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left', fontWeight: 600, color: 'var(--tp-muted)' }}>Haiku ↓ Jev →</th>
            {TIERS.map((t) => (
              <th key={t} style={{ ...cell, fontWeight: 600 }}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TIERS.map((h) => (
            <tr key={h}>
              <th style={{ ...cell, textAlign: 'left', fontWeight: 600 }}>{h}</th>
              {TIERS.map((j) => (
                <td
                  key={j}
                  data-testid={`admin-jev-compare-${h}-${j}`}
                  style={{ ...cell, fontWeight: h === j ? 700 : 400 }}
                >
                  {c.matrix[h][j]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function JevSwitch({ mode, config, stats, compare, overrides, minMargin }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function flip(next: JevModeProp) {
    if (inFlight.current || next === mode) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/jev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
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

  const overrideCount = overrides ? overrides.on + overrides.compare + overrides.off : 0;

  return (
    <div data-testid="admin-jev">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Message classifier</h2>
        <div
          role="radiogroup"
          aria-label="Message classifier for every account"
          data-testid="admin-jev-switch"
          style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}
        >
          {MODES.map((m) => {
            const selected = m.value === mode;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => void flip(m.value)}
                disabled={busy}
                data-testid={`admin-jev-mode-${m.value}`}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--tp-border-strong)',
                  background: selected ? 'var(--tp-primary)' : 'transparent',
                  color: selected ? '#FFFFFF' : 'var(--tp-subtle)',
                  cursor: busy || selected ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {config.configured ? (
        <p style={line} data-testid="admin-jev-config">
          Jev at <code>{config.host}</code> ({config.model}
          {config.keySet ? ', key set' : ', no key'}) settles a T1 at p ≥ {config.t1Min} leading
          by ≥ {minMargin}, within {config.timeoutMs} ms. Everything else goes to Haiku.
          {mode === 'compare' ? ' In compare, Haiku decides every message and Jev’s answer is only logged.' : ''}
        </p>
      ) : (
        <p style={{ ...line, color: mode !== 'off' ? 'var(--tp-danger)' : line.color }} data-testid="admin-jev-config">
          Jev is not configured: {config.reason}.
          {mode === 'on' ? ' The switch is on, and every message is still going to Haiku.' : ''}
          {mode === 'compare' ? ' Compare is on, and nothing is being compared.' : ''}
        </p>
      )}

      {overrides === null ? (
        <p style={line}>Could not read the per-account overrides.</p>
      ) : overrideCount > 0 ? (
        <p style={line} data-testid="admin-jev-overrides">
          {overrides.on} account{overrides.on === 1 ? '' : 's'} forced to Jev first, {overrides.compare} to
          compare and {overrides.off} to Haiku only ignore this switch.
        </p>
      ) : null}

      {stats === null ? (
        <p style={{ ...line, color: 'var(--tp-danger)' }}>Could not read Jev&apos;s results.</p>
      ) : stats.calls === 0 ? (
        mode === 'on' || (overrides?.on ?? 0) > 0 ? (
          <p style={line} data-testid="admin-jev-stats">No Jev-first calls in the last {stats.days} days.</p>
        ) : null
      ) : (
        <p style={line} data-testid="admin-jev-stats">
          Jev first, last {stats.days} days: Jev settled <strong>{stats.settled}</strong> of {stats.calls} (
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

      <JevCompareSection
        compare={compare}
        show={mode === 'compare' || (overrides?.compare ?? 0) > 0}
      />

      {error && (
        <p role="alert" style={{ ...line, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
