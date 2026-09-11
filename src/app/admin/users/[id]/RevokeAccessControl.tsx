'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'revoke' | 'reactivate';

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
  /** The row is `revoked`. This control then points the other way. */
  alreadyRevoked: boolean;
  /**
   * What the account lands back on, decided SERVER-side by `planReactivation`
   * + `reactivationLandingLine`. Null when the undo is not available.
   *
   * Computed there and not here on purpose: which status comes back is a
   * payments decision, and a client that worked it out for itself would be a
   * second implementation of the rule that decides whether somebody has paid.
   */
  reactivateLanding: string | null;
  /**
   * Why the undo is unavailable, when it is — today that is only a row revoked
   * before `pre_revoke_status` existed. Shown instead of the button, because a
   * disabled control with no sentence is what this whole change is fixing.
   */
  reactivateBlockedMessage: string | null;
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
 * Break-glass access, both directions.
 *
 * The file is still named for the revoke because that is the dangerous half and
 * the half a reader comes looking for. It grew the undo on 2026-09-10: before
 * that the button turned into a dead "Access already revoked" and there was no
 * route, no repo function and no UI that moved a row back out, so a misfire —
 * or a `REFUND` webhook that turned out to be wrong — was unfixable from the
 * product.
 *
 * There is deliberately NO refund button anywhere near either of them. Apple
 * owns the money; there is no developer-initiated refund for IAP, and a button
 * implying otherwise would be a lie in the UI.
 *
 * The obstruction is shared and the weight is not. Both directions demand a
 * typed reason — that is what makes a click a decision still explicable months
 * later, and both are recorded — but only the revoke wears danger styling.
 * Restoring access is the recoverable direction, and dressing it in the same
 * red as the one that takes a year away teaches an admin to ignore red.
 */
export default function RevokeAccessControl({
  userId,
  userLabel,
  paidThrough,
  alreadyRevoked,
  reactivateLanding,
  reactivateBlockedMessage,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Same re-entrancy guard as the delete dialog: state is async, a ref is not.
  const inFlight = useRef(false);

  const mode: Mode = alreadyRevoked ? 'reactivate' : 'revoke';
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
      const res = await fetch(`/api/admin/subscription/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `${mode === 'revoke' ? 'Revoke' : 'Re-activation'} failed (${res.status})`);
      }
      close();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // The undo is unavailable only for a row revoked before `pre_revoke_status`
  // existed — the status it should come back to is not recorded anywhere on the
  // row, and guessing it is how an expired account silently becomes a free one.
  const undoBlocked = mode === 'reactivate' && reactivateBlockedMessage !== null;

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={undoBlocked}
          style={
            mode === 'reactivate'
              ? {
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  border: '1px solid var(--tp-border)',
                  background: undoBlocked ? 'var(--tp-surface-muted)' : 'var(--tp-surface)',
                  color: undoBlocked ? 'var(--tp-subtle)' : 'var(--tp-text)',
                  cursor: undoBlocked ? 'default' : 'pointer',
                }
              : {
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  border: '1px solid rgba(198, 93, 74, 0.5)',
                  background: 'var(--tp-danger-muted)',
                  color: 'var(--tp-danger)',
                  cursor: 'pointer',
                }
          }
        >
          {mode === 'reactivate' ? 'Re-activate access' : 'Revoke access'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--tp-subtle)', maxWidth: '60ch', lineHeight: 1.5 }}>
          {mode === 'reactivate' ? (
            reactivateBlockedMessage ?? reactivateLanding
          ) : (
            <>
              Break-glass only — genuine abuse, or a REFUND webhook that never
              arrived. This is not a refund: the money is Apple&apos;s to return and
              nothing here moves it.{' '}
              <strong style={{ color: 'var(--tp-muted)' }}>
                Cancelling is not a reason to press this
              </strong>{' '}
              — a cancelled subscriber keeps the term they bought.
            </>
          )}
        </span>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={mode === 'reactivate' ? 'Re-activate access' : 'Revoke access'}
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
              {mode === 'reactivate'
                ? `Re-activate access for ${userLabel}?`
                : `Revoke access for ${userLabel}?`}
            </h3>

            {/*
              The sentence the design doc asks for, verbatim in shape:
              "This user has paid through 2027-03-14." Shown only when there IS
              time left, so it never becomes wallpaper. Revoke only — on the way
              back it is not an argument against anything.
            */}
            {mode === 'revoke' && paidThrough && (
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

            {/*
              What they land back on, before the press rather than after it.
              "Re-activated" is not a state: the admin is handing back a
              specific status with a specific end date, and both are on the row
              already.
            */}
            {mode === 'reactivate' && reactivateLanding && (
              <p
                style={{
                  margin: '0 0 10px',
                  padding: '8px 10px',
                  background: 'var(--tp-surface-muted)',
                  borderRadius: 'var(--tp-radius-sm, 8px)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--tp-text)',
                }}
              >
                {reactivateLanding}
              </p>
            )}

            <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.6 }}>
              {mode === 'reactivate' ? (
                <>
                  Re-opens planning and their existing trips. It hands back the plan that
                  was there when it was revoked — not a new one — so an account that had
                  already run out comes back run out.
                </>
              ) : (
                <>
                  Blocks planning and closes their existing trips immediately. It does not
                  refund anything — refunds are requested from Apple by the user, and Apple
                  decides. If they simply cancelled, close this dialog: they keep the term
                  they bought.
                </>
              )}
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
              placeholder={
                mode === 'reactivate'
                  ? 'e.g. revoked by mistake — the REFUND was for a different account'
                  : 'e.g. REFUND notification never arrived — refund confirmed in App Store Connect'
              }
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
                  background:
                    armed && !busy
                      ? mode === 'reactivate'
                        ? 'var(--tp-primary)'
                        : 'var(--tp-danger)'
                      : 'var(--tp-border)',
                  color: armed && !busy ? '#FFFFFF' : 'var(--tp-subtle)',
                  cursor: armed && !busy ? 'pointer' : 'default',
                }}
              >
                {mode === 'reactivate'
                  ? busy
                    ? 'Re-activating…'
                    : 'Re-activate access'
                  : busy
                    ? 'Revoking…'
                    : 'Revoke access'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
