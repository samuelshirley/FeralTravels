'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  userId: string;
  userLabel: string;
  /** `users.paywall_enforced` as it stands right now. */
  enforced: boolean;
  /**
   * Comped accounts are entitled inside `resolveAccountState`, before the
   * switch is consulted — so the override cannot wall one, and the UI has to
   * say that rather than let somebody flip it and conclude the paywall is
   * broken.
   */
  comped: boolean;
  /**
   * The deployment-wide switch. When it is ON everybody is enforced already
   * and this control changes nothing observable, which is worth saying for the
   * same reason.
   */
  globalOn: boolean;
}

/**
 * Per-account paywall enforcement.
 *
 * The global switch has to stay off — the web app is the demo while the iOS
 * build is in review, and enforcement would wall every account past its trial
 * with nothing to buy. But a paywall nobody has ever watched work is not
 * something to turn on for the first time on launch day. So this forces the
 * wall onto ONE account: make a test user, flip this, sign in as them, walk
 * into it.
 *
 * It is a switch rather than a button because it goes both ways and both
 * directions are real — unlike the location permission in Settings, where the
 * platform owns the off direction. Nothing is confirmed and nothing is typed:
 * the accounts this is pressed on are disposable by construction, and the
 * obstruction that `RevokeAccessControl` puts in the way exists because that
 * one takes away access somebody paid for. This does not.
 */
export default function PaywallEnforceControl({
  userId,
  userLabel,
  enforced,
  comped,
  globalOn,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // State is async, a ref is not — same re-entrancy guard the revoke dialog uses.
  const inFlight = useRef(false);

  async function toggle() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/paywall/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, enforced: !enforced }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Could not change the override (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the override');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
            Force the paywall on this account
          </div>
          <div style={{ fontSize: 11, color: 'var(--tp-subtle)', lineHeight: 1.5, maxWidth: '62ch' }}>
            Enforces the paywall for {userLabel} even while the deployment-wide switch is
            off. Nobody else is affected.
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enforced}
          aria-label={`Force the paywall on ${userLabel}`}
          onClick={toggle}
          disabled={busy}
          data-testid="admin-paywall-override-toggle"
          style={{
            position: 'relative',
            flexShrink: 0,
            width: 46,
            height: 26,
            borderRadius: 999,
            border: '1px solid var(--tp-border)',
            background: enforced ? 'var(--tp-primary)' : 'var(--tp-surface-muted)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            transition: 'background 160ms ease',
            padding: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 2,
              left: enforced ? 22 : 2,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: '#FFFFFF',
              transition: 'left 160ms ease',
            }}
          />
        </button>
      </div>

      {/*
        Both of these are "you pressed it and nothing happened" explanations,
        shown BEFORE that happens. Each is the true reason the flag is inert,
        and neither is a reason to change the precedence — see the comment on
        `users.paywall_enforced`.
      */}
      {comped && enforced && (
        <p
          style={{
            margin: '12px 0 0',
            padding: '8px 10px',
            background: 'var(--tp-surface-muted)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--tp-muted)',
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: 'var(--tp-text)' }}>This account is comped</strong>, so it is
          entitled before the paywall switch is ever consulted and this override does nothing.
          Comped is the author&apos;s account and the E2E fixtures. Use a disposable account
          instead — <code>npm run test-user -- --days 8</code>.
        </p>
      )}

      {globalOn && (
        <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--tp-muted)', lineHeight: 1.6 }}>
          Enforcement is already ON for the whole deployment, so this account is walled either
          way. The override matters only while the global switch is off.
        </p>
      )}

      <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--tp-subtle)', lineHeight: 1.6, maxWidth: '70ch' }}>
        This proves the <strong>gate</strong> — that an expired account sees the wall on web and
        in the app, that existing trips behave, that Penny refuses. It does not prove the{' '}
        <strong>transaction</strong>: a real purchase needs a sandbox Apple ID on a TestFlight
        build. A wall that appears is not a wall you can pay your way past.
      </p>

      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
