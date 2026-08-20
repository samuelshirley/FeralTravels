'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';
import { apiFetch, ApiError } from '@/lib/api';
import { DELETE_CONFIRM_PHRASE, isDeleteConfirmationValid } from '@/lib/accountDeletion';

/**
 * "Danger zone" at the foot of Settings — the user-facing half of account
 * deletion. Exists because App Store guideline 5.1.1(v) requires an account
 * that can be created in the app to be deletable from it; the web page mirrors
 * the native screen so the two clients don't drift.
 *
 * The interaction is deliberately obstructive. Deletion here is immediate and
 * unrecoverable — there is no grace period and no undo — so the cost of an
 * accidental tap is total. Typing the phrase is what converts a tap into a
 * decision. Everything else follows from that: the destructive button starts
 * disabled, Cancel is the visually quiet option, and Escape / backdrop clicks
 * close the dialog rather than confirming it.
 */
export default function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Re-entrancy guard. `deleting` is state, so two clicks processed before React
   * re-renders would both read `false` and both POST — the second lands on a
   * user row that no longer exists and comes back as "Account not found." over
   * an account that was in fact deleted. A ref updates synchronously.
   */
  const inFlight = useRef(false);

  const armed = isDeleteConfirmationValid(confirmText);

  useEffect(() => {
    if (!open) return;
    // Focus the confirm field rather than a button: the first thing the dialog
    // should invite is typing, not pressing.
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !deleting) close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deleting]);

  function close() {
    setOpen(false);
    setConfirmText('');
    setError(null);
  }

  async function confirmDelete() {
    if (!armed || inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);

    try {
      await apiFetch('/api/me/delete', {
        method: 'POST',
        body: { confirm: confirmText },
        // This component renders its own inline error inside the dialog. The
        // global notifier would stack a second toast on top of a modal the
        // user is already reading.
        skipGlobalErrorReport: true,
      });
    } catch (e) {
      inFlight.current = false;
      setDeleting(false);
      setError(
        e instanceof ApiError ? e.message : 'Could not delete your account. Please try again.'
      );
      return;
    }

    // Past this point the account is GONE, so nothing here may surface as a
    // failure. Signing out is only housekeeping — the session row cascaded away
    // with the user, so the cookie is already worthless. Keeping it inside the
    // try above meant a flaky signOut fetch rendered "Could not delete your
    // account. Please try again." over a successful, irreversible deletion, and
    // the retry would come back "Unauthorized". A hard navigation is the
    // fallback: the cookie points at nothing either way.
    try {
      await signOut({ callbackUrl: '/login' });
    } catch {
      window.location.href = '/login';
    }
  }

  return (
    <>
      <div
        style={{
          fontSize: 11,
          color: 'var(--tp-danger)',
          letterSpacing: '0.15em',
          marginTop: 32,
          marginBottom: 4,
        }}
      >
        DANGER ZONE
      </div>
      <section
        style={{
          background: 'var(--tp-danger-muted)',
          border: '1px solid rgba(198, 93, 74, 0.4)',
          borderRadius: 'var(--tp-radius-md)',
          padding: 20,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 6, fontSize: 16, fontWeight: 700, color: 'var(--tp-text)' }}>
          Delete account
        </h2>
        <p style={{ margin: 0, marginBottom: 14, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
          Permanently deletes your account and everything in it — your trips, routes, stops,
          fuel plans, vehicles and your whole conversation history with Penny. This happens
          immediately and cannot be undone.
        </p>
        <button
          type="button"
          data-testid="delete-account-open"
          onClick={() => setOpen(true)}
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: '9px 14px',
            background: 'transparent',
            color: 'var(--tp-danger)',
            border: '1px solid rgba(198, 93, 74, 0.55)',
            borderRadius: 'var(--tp-radius-sm)',
            cursor: 'pointer',
          }}
        >
          Delete account
        </button>
      </section>

      {open && (
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) close();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            data-testid="delete-account-dialog"
            style={{
              background: 'var(--tp-surface)',
              border: '1px solid var(--tp-border)',
              borderRadius: 'var(--tp-radius-md)',
              padding: 24,
              maxWidth: 420,
              width: '100%',
              boxShadow: 'var(--tp-shadow-lg, 0 20px 60px rgba(0,0,0,0.4))',
            }}
          >
            <h3
              id="delete-account-title"
              style={{ margin: 0, marginBottom: 10, fontSize: 18, fontWeight: 700, color: 'var(--tp-text)' }}
            >
              Are you sure you want to delete your account?
            </h3>
            <p style={{ margin: 0, marginBottom: 16, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
              Everything goes: trips, routes, stops, fuel plans, vehicles and your chat history.
              This cannot be undone and there is no recovery window.
            </p>

            <label
              htmlFor="delete-account-confirm"
              style={{ display: 'block', fontSize: 13, color: 'var(--tp-text)', marginBottom: 6 }}
            >
              Type <strong>{DELETE_CONFIRM_PHRASE}</strong> to confirm
            </label>
            <input
              id="delete-account-confirm"
              data-testid="delete-account-confirm-input"
              ref={inputRef}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={deleting}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={DELETE_CONFIRM_PHRASE}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                fontSize: 14,
                background: 'var(--tp-surface-muted)',
                color: 'var(--tp-text)',
                border: '1px solid var(--tp-border)',
                borderRadius: 'var(--tp-radius-sm)',
                marginBottom: error ? 8 : 16,
              }}
            />

            {error && (
              <div
                data-testid="delete-account-error"
                style={{ fontSize: 12, color: 'var(--tp-danger)', marginBottom: 12 }}
              >
                {error}
              </div>
            )}

            <button
              type="button"
              data-testid="delete-account-confirm-button"
              onClick={confirmDelete}
              disabled={!armed || deleting}
              style={{
                width: '100%',
                fontSize: 15,
                fontWeight: 700,
                padding: '13px 16px',
                background: armed && !deleting ? 'var(--tp-danger)' : 'rgba(198, 93, 74, 0.35)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--tp-radius-sm)',
                cursor: armed && !deleting ? 'pointer' : 'not-allowed',
                marginBottom: 8,
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              data-testid="delete-account-cancel"
              onClick={close}
              disabled={deleting}
              style={{
                width: '100%',
                fontSize: 14,
                fontWeight: 500,
                padding: '11px 16px',
                background: 'transparent',
                color: 'var(--tp-muted)',
                border: 'none',
                borderRadius: 'var(--tp-radius-sm)',
                cursor: deleting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
