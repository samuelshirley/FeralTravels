'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The deployment-wide paywall switch, pressable.
 *
 * `POST /api/admin/paywall` shipped with nothing that called it: the header
 * rendered the state as a plain pill, so the switch that moved out of Vercel
 * "because a switch whose entire purpose is being flipped back in a hurry
 * cannot take a build" could only be flipped from devtools.
 *
 * Same shape as `users/[id]/PaywallEnforceControl.tsx` — a ref re-entrancy
 * guard, `router.refresh()` after a flip, an inline error, disabled while in
 * flight — with ONE deliberate difference: this asks for a second tap, in both
 * directions. That control needs no confirmation because the accounts it is
 * pressed on are disposable by construction. This one walls, or unwalls, every
 * account at once. The confirmation is inline rather than a browser dialog, so
 * the hurried direction (OFF, when the wall is blocking people it should not)
 * costs one extra tap and nothing more.
 */
export default function PaywallSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State is async, a ref is not — same re-entrancy guard the per-user control uses.
  const inFlight = useRef(false);

  async function flip() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/paywall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !on }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Could not change the paywall switch (${res.status})`);
      }
      setArming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the paywall switch');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const small: React.CSSProperties = {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 999,
    cursor: busy ? 'default' : 'pointer',
  };

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
      }}
    >
      {arming && (
        <>
          <span style={{ fontSize: 11, color: 'var(--tp-muted)' }}>
            {on
              ? 'Every account gets full access again.'
              : 'Every account past its trial is walled.'}
          </span>
          <button
            type="button"
            onClick={() => void flip()}
            disabled={busy}
            data-testid="admin-paywall-switch-confirm"
            style={{
              ...small,
              fontWeight: 700,
              border: '1px solid #b3261e',
              background: '#b3261e',
              color: '#fff',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Switching…' : `Turn ${on ? 'OFF' : 'ON'}`}
          </button>
          <button
            type="button"
            onClick={() => setArming(false)}
            disabled={busy}
            style={{
              ...small,
              border: '1px solid var(--tp-border)',
              background: 'transparent',
              color: 'var(--tp-muted)',
            }}
          >
            Cancel
          </button>
        </>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => {
          setError(null);
          setArming((a) => !a);
        }}
        disabled={busy}
        data-testid="admin-paywall-switch"
        title={
          on
            ? 'Enforcement is ON — verdicts block.'
            : 'Enforcement is OFF — applySwitch grants every account full access. Trial and cap states are still tracked and still shown; they just cannot block anyone.'
        }
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          padding: '3px 8px',
          borderRadius: 999,
          border: '1px solid var(--tp-border-strong)',
          background: 'transparent',
          color: on ? 'var(--tp-text)' : 'var(--tp-subtle)',
          cursor: busy ? 'default' : 'pointer',
        }}
      >
        PAYWALL {on ? 'ON' : 'OFF'}
      </button>
      {error && (
        <span role="alert" style={{ flexBasis: '100%', textAlign: 'right', fontSize: 12, color: 'var(--tp-danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
