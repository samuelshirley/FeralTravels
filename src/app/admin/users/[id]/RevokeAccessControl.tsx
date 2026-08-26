'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  userId: string;
  userLabel: string;
  /**
   * ISO date (YYYY-MM-DD) this account has paid through, or null when there is
   * nothing left on the clock. When it is set, the confirmation says so in
   * words — revoking then takes away time somebody has already paid for, and
   * the UI is supposed to argue back rather than let that happen quietly.
   */
  paidThrough: string | null;
  /** Already revoked — the button has nothing left to do. */
  alreadyRevoked: boolean;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm, 8px)',
  fontFamily: 'inherit',
  color: 'var(--tp-text)',
  background: 'var(--tp-surface)',
  boxSizing: 'border-box',
};

/**
 * Break-glass revoke, and the argument against pressing it.
 *
 * There is deliberately NO refund button anywhere near this. Apple owns the
 * money; there is no developer-initiated refund for IAP, and a button implying
 * otherwise would be a lie in the UI. This one control removes access and does
 * nothing else.
 *
 * The obstruction is the point, mirroring DeleteAccountSection: the reason
 * field starts empty and the destructive button stays disabled until it is
 * filled in, because a typed sentence is what turns a click into a decision
 * that is still explicable months later.
 */
export default function RevokeAccessControl({
  userId,
  userLabel,
  paidThrough,
  alreadyRevoked,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Same re-entrancy guard as the delete dialog: state is async, a ref is not.
  const inFlight = useRef(false);

  const armed = reason.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  function close() {
    setOpen(false);
    setReason('');
    setError(null);
  }

  async function confirm() {
    if (!armed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/subscription/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Revoke failed (${res.status})`);
      }
      close();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={alreadyRevoked}
          style={{
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 'var(--tp-radius-sm, 8px)',
            border: '1px solid rgba(198, 93, 74, 0.5)',
            background: alreadyRevoked ? 'var(--tp-surface-muted)' : 'var(--tp-danger-muted)',
            color: alreadyRevoked ? 'var(--tp-subtle)' : 'var(--tp-danger)',
            cursor: alreadyRevoked ? 'default' : 'pointer',
          }}
        >
          {alreadyRevoked ? 'Access already revoked' : 'Revoke access'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--tp-subtle)', maxWidth: '60ch', lineHeight: 1.5 }}>
          Break-glass only — genuine abuse, or a REFUND webhook that never
          arrived. This is not a refund: the money is Apple&apos;s to return and
          nothing here moves it.{' '}
          <strong style={{ color: 'var(--tp-muted)' }}>
            Cancelling is not a reason to press this
          </strong>{' '}
          — a cancelled subscriber keeps the term they bought.
        </span>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Revoke access"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) close();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--tp-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              boxShadow: 'var(--tp-shadow-md)',
              padding: 20,
              width: '100%',
              maxWidth: 460,
            }}
          >
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 16, fontWeight: 700 }}>
              Revoke access for {userLabel}?
            </h3>

            {/*
              The sentence the design doc asks for, verbatim in shape:
              "This user has paid through 2027-03-14." Shown only when there IS
              time left, so it never becomes wallpaper.
            */}
            {paidThrough && (
              <p
                style={{
                  margin: '0 0 10px',
                  padding: '8px 10px',
                  background: 'var(--tp-danger-muted)',
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--tp-danger)',
                }}
              >
                This user has paid through {paidThrough}. Revoking takes away time they
                already paid for.
              </p>
            )}

            <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.6 }}>
              Blocks planning and closes their existing trips immediately. It does not
              refund anything — refunds are requested from Apple by the user, and Apple
              decides. If they simply cancelled, close this dialog: they keep the term
              they bought.
            </p>

            <label
              htmlFor="revoke-reason"
              style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}
            >
              Reason (recorded with your email and the time)
            </label>
            <input
              id="revoke-reason"
              ref={inputRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. REFUND notification never arrived — refund confirmed in App Store Connect"
              disabled={busy}
              style={inputStyle}
            />

            {error && (
              <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--tp-danger)' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                style={{
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  border: '1px solid var(--tp-border)',
                  background: 'transparent',
                  color: 'var(--tp-muted)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={!armed || busy}
                style={{
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 700,
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  border: 'none',
                  background: armed && !busy ? 'var(--tp-danger)' : 'var(--tp-border)',
                  color: armed && !busy ? '#FFFFFF' : 'var(--tp-subtle)',
                  cursor: armed && !busy ? 'pointer' : 'default',
                }}
              >
                {busy ? 'Revoking…' : 'Revoke access'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
