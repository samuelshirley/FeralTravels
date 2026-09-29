'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Override = 'on' | 'off' | null;

interface Props {
  userId: string;
  userLabel: string;
  /** `users.jev_mode` as it stands; null follows the global switch. Undefined when the read failed. */
  override: Override | undefined;
  /** The deployment-wide switch, so "follow" can say what it resolves to. */
  globalOn: boolean;
}

/**
 * Which classifier the message gate asks for ONE account.
 *
 * Three states, not a switch, because there are three real answers: follow the
 * global switch (the default, and what almost every account should be), force
 * Jev-first — to try Jev on one test account while the global switch is off —
 * or force Haiku, to hold one account on today's behaviour while it is on.
 *
 * Same shape as `PaywallEnforceControl`: a ref re-entrancy guard,
 * `router.refresh()` after a change, an inline error. Nothing is confirmed:
 * every state is one tap back, and none of them can refuse a message — Jev may
 * only let one through.
 */
export default function JevModeControl({ userId, userLabel, override, globalOn }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function set(mode: Override) {
    if (inFlight.current || mode === override) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/jev/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, mode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Could not change the classifier (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the classifier');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const options: Array<{ value: Override; label: string }> = [
    { value: null, label: `Follow global (${globalOn ? 'Jev' : 'Haiku'})` },
    { value: 'on', label: 'Jev first' },
    { value: 'off', label: 'Haiku only' },
  ];

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        Message classifier for {userLabel}
      </div>
      {override === undefined ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--tp-danger)' }}>
          Could not read this account&apos;s classifier setting.
        </p>
      ) : (
        <div role="radiogroup" aria-label={`Message classifier for ${userLabel}`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {options.map((o) => {
            const selected = o.value === override;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                onClick={() => void set(o.value)}
                data-testid={`admin-jev-user-${o.value ?? 'global'}`}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--tp-border-strong)',
                  background: selected ? 'var(--tp-primary)' : 'transparent',
                  color: selected ? '#FFFFFF' : 'var(--tp-text)',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
