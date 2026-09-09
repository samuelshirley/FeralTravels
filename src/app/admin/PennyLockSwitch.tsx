'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Close the app to Penny, and open it again.
 *
 * The one control here that is not a reading. Everything else in the lockdown
 * block reports what the breakers measured; this is the owner deciding, for
 * whatever reason, that Penny stops spending money right now — from a phone, in
 * one tap, with no deploy.
 *
 * Deliberately not a toggle switch. Throwing this stops every non-admin from
 * planning anything, so it asks for a second tap when it is being turned ON,
 * and none when it is being turned off: the direction that hurts is the one
 * that needs the friction, and the direction that repairs must never be behind
 * a confirmation nobody can dismiss in a hurry.
 */
export default function PennyLockSwitch({ locked }: { locked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/admin/penny-lock', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locked: next }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setArming(false);
        router.refresh();
      } catch (err) {
        // Never swallowed: an admin who thinks they have closed the app and
        // has not is worse off than one who was told it failed.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [router]
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {locked ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void flip(false)}
          data-testid="penny-lock-off"
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--tp-border-strong)',
            background: 'var(--tp-surface)',
            color: 'var(--tp-text)',
            fontWeight: 600,
            fontSize: 13,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Opening…' : 'Open Penny back up'}
        </button>
      ) : arming ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void flip(true)}
            data-testid="penny-lock-confirm"
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #b3261e',
              background: '#b3261e',
              color: '#fff',
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? 'Closing…' : 'Yes — stop Penny for everyone'}
          </button>
          <button
            type="button"
            onClick={() => setArming(false)}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--tp-border)',
              background: 'transparent',
              color: 'var(--tp-muted)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setArming(true)}
          data-testid="penny-lock-on"
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--tp-border-strong)',
            background: 'transparent',
            color: 'var(--tp-text)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Close the app to Penny
        </button>
      )}
      {error ? (
        <span style={{ fontSize: 12, color: '#b3261e' }}>Didn’t stick: {error}</span>
      ) : null}
    </div>
  );
}
