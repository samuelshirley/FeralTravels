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
 * flight — and, since 2026-09-21, the same ONE-TAP behaviour in both
 * directions.
 *
 * It shipped that morning with an inline second tap, on the argument that this
 * control walls or unwalls every account at once. Sam's call, the same day: the
 * confirmation buys nothing worth its cost. The switch exists to be flipped in
 * a hurry, both directions are recoverable by flipping it back, the state is
 * legible in the pill itself the moment the refresh lands, and a confirmation
 * step on the one control you reach for while production is wrong is a step you
 * pay for every time to prevent a mis-click that has never happened. The
 * destructive admin actions that DO confirm — the break-glass revoke, the test
 * user block — confirm because they are not reversible by pressing the same
 * button again.
 */
export default function PaywallSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State is async, a ref is not — same re-entrancy guard the per-user control
  // uses, and the only thing standing between a double-click and two POSTs.
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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the paywall switch');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

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
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => void flip()}
        disabled={busy}
        data-testid="admin-paywall-switch"
        title={
          on
            ? 'Enforcement is ON — verdicts block. One tap turns it off for every account.'
            : 'Enforcement is OFF — applySwitch grants every account full access. Trial and cap states are still tracked and still shown; they just cannot block anyone. One tap walls every account past its trial.'
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
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'SWITCHING…' : `PAYWALL ${on ? 'ON' : 'OFF'}`}
      </button>
      {error && (
        <span role="alert" style={{ flexBasis: '100%', textAlign: 'right', fontSize: 12, color: 'var(--tp-danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
