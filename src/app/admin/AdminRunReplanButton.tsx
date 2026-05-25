'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Shape returned by POST /api/admin/run-replan (mirrors RunReplanResult in
 * src/lib/replan/runReplan.ts — kept as a local interface because that module
 * is server-only and can't be imported into a client component).
 */
interface RunReplanResult {
  ok: boolean;
  forced: boolean;
  reason?: string;
  duration_ms: number;
  active_trips: number;
  replanned: number;
  off_route: number;
  skipped: number;
}

/**
 * Admin-only button that manually triggers the nightly replan (the automatic
 * cron is disabled — see vercel.json / the cron route comment). Because a run
 * sends real emails to travelers, the button requires a second confirming
 * click before it fires, then shows an inline summary of what happened.
 */
export default function AdminRunReplanButton() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunReplanResult | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await apiFetch<RunReplanResult>('/api/admin/run-replan', {
        method: 'POST',
      });
      setResult(res);
    } catch {
      // The global ErrorNotifier already surfaces the failure as a toast/modal.
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      {!confirming ? (
        <button
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
          disabled={busy}
          style={btnStyle('primary', busy)}
        >
          Run nightly replan now
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
            Sends real emails —
          </span>
          <button onClick={run} disabled={busy} style={btnStyle('danger', busy)}>
            {busy ? 'Running…' : 'Confirm & send'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            style={btnStyle('ghost', busy)}
          >
            Cancel
          </button>
        </div>
      )}

      {result && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--tp-muted)',
            textAlign: 'right',
            lineHeight: 1.5,
            maxWidth: 320,
          }}
        >
          {result.reason ? (
            <span>No-op: {result.reason}</span>
          ) : (
            <span>
              Done in {(result.duration_ms / 1000).toFixed(1)}s ·{' '}
              {result.active_trips} active · {result.replanned} replanned ·{' '}
              {result.off_route} off-route · {result.skipped} skipped
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function btnStyle(
  variant: 'primary' | 'danger' | 'ghost',
  busy: boolean,
): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 12px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    cursor: busy ? 'wait' : 'pointer',
  };
  if (variant === 'danger') {
    return {
      ...base,
      background: 'var(--tp-danger-muted)',
      border: '1px solid rgba(198, 93, 74, 0.35)',
      color: 'var(--tp-danger)',
    };
  }
  if (variant === 'ghost') {
    return {
      ...base,
      background: 'transparent',
      border: '1px solid var(--tp-border)',
      color: 'var(--tp-muted)',
    };
  }
  return {
    ...base,
    background: 'var(--tp-primary-muted)',
    border: '1px solid var(--tp-border)',
    color: 'var(--tp-primary)',
  };
}
