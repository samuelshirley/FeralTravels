'use client';

import { useCallback, useState } from 'react';
import type { SubscriptionStatus } from '@/types/entitlement';

interface TestAccountRow {
  id: string;
  email: string;
  /** ISO — Dates do not survive the server/client boundary. */
  createdAt: string;
  subscriptionStatus: SubscriptionStatus | null;
  spendMicrocents: number;
}

interface CreateArgs {
  ageDays: number;
  subscription: SubscriptionStatus | null;
  periodEndsInDays?: number;
  autoRenew?: boolean;
  spendUsd?: number;
}

interface Preset {
  key: string;
  /** What the tester will SEE. The internal state name is the sub-line. */
  label: string;
  produces: string;
  args: CreateArgs;
  /** The main one — the account this whole page exists to make. */
  primary?: boolean;
}

/**
 * One click per state worth testing.
 *
 * Typing four parameters to reach `trial_expired` is the friction being
 * removed, so the parameters live here and the buttons are named after what
 * the tester will see on screen. Every row lands on a real state from
 * `payments/states.ts` — the numbers are chosen against the thresholds in
 * `payments/constants.ts` (trial 7 days, trial ceiling $1, usage cap $8.50),
 * not picked to look plausible.
 */
const PRESETS: Preset[] = [
  {
    key: 'day7',
    label: 'Day 7 — paywalled',
    produces: 'trial_expired · blocked, trips still readable',
    args: { ageDays: 7, subscription: null },
    primary: true,
  },
  {
    key: 'day0',
    label: 'Day 0 — fresh trial',
    produces: 'trial · full access',
    args: { ageDays: 0, subscription: null },
  },
  {
    key: 'day6',
    label: 'Day 6 — trial nearly up',
    produces: 'trial · one day left, countdown copy',
    args: { ageDays: 6, subscription: null },
  },
  {
    key: 'burned',
    label: 'Trial burned through',
    produces: 'trial_spent · $1.20 of a $1 ceiling, day 3',
    args: { ageDays: 3, subscription: null, spendUsd: 1.2 },
  },
  {
    key: 'subscribed',
    label: 'Subscribed',
    produces: 'subscribed · full access, renews',
    args: { ageDays: 30, subscription: 'active', periodEndsInDays: 300 },
  },
  {
    key: 'cancelled',
    label: 'Cancelled, still paid up',
    produces: 'cancelled_in_period · full access for 30 more days',
    args: {
      ageDays: 30,
      subscription: 'cancelled',
      periodEndsInDays: 30,
      autoRenew: false,
    },
  },
  {
    key: 'expired',
    label: 'Subscription expired',
    produces: 'expired · period ended yesterday, blocked',
    args: { ageDays: 400, subscription: 'active', periodEndsInDays: -1 },
  },
  {
    key: 'capped',
    label: 'Over the usage cap',
    produces: 'subscribed_capped · $9 against an $8.50 cap',
    args: { ageDays: 30, subscription: 'active', periodEndsInDays: 300, spendUsd: 9 },
  },
  {
    key: 'refunded',
    label: 'Refunded',
    produces: 'refunded · blocked, existing trips unreadable too',
    args: { ageDays: 30, subscription: 'refunded', periodEndsInDays: 30 },
  },
];

const SUBSCRIPTION_OPTIONS: SubscriptionStatus[] = [
  'active',
  'grace',
  'cancelled',
  'expired',
  'refunded',
  'revoked',
];

const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--tp-muted)',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm, 8px)',
  fontFamily: 'inherit',
  color: 'var(--tp-text)',
  background: 'var(--tp-surface)',
  boxSizing: 'border-box',
};

const smallBtn: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'inherit',
  borderRadius: 6,
  border: '1px solid var(--tp-border)',
  background: 'var(--tp-surface)',
  color: 'var(--tp-text)',
  cursor: 'pointer',
};

const monoStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  wordBreak: 'break-all',
};

function dollars(microcents: number): string {
  const usd = microcents / 100_000_000;
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

function ageInDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Absolute, because the entire point is pasting it into a different window.
 * Only ever called from an event handler, so `window` is safe and the server
 * render never has to guess an origin it does not know.
 */
function signInLink(email: string): string {
  return `${window.location.origin}/login/verify?email=${encodeURIComponent(email)}`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through — a rejected permission is not a reason to give up.
  }
  // `next dev` over a LAN IP is not a secure context, and testing on a phone
  // against the dev box is exactly when this page gets used. execCommand is
  // deprecated but it is the only thing that works there.
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({
  value,
  label = 'Copy',
  emphasis,
}: {
  value: string;
  label?: string;
  emphasis?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(value);
        setState(ok ? 'done' : 'failed');
        window.setTimeout(() => setState('idle'), 1400);
      }}
      style={{
        ...smallBtn,
        flexShrink: 0,
        ...(emphasis
          ? {
              border: 'none',
              background: 'var(--tp-primary)',
              color: 'var(--tp-on-primary)',
            }
          : null),
      }}
    >
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

/** What a row is currently showing under itself, if anything. */
interface RowDetail {
  code: string | null;
  link: string;
  note: string | null;
}

interface CreatedAccount {
  email: string;
  code: string | null;
  link: string;
}

export default function TestUsersClient({
  initialAccounts,
}: {
  initialAccounts: TestAccountRow[];
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [created, setCreated] = useState<CreatedAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key at a time: a preset key, or `${action}:${email}` for a row action.
  const [busy, setBusy] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RowDetail>>({});
  // Two-step delete arms per row. See the comment on `handleDelete`.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // Custom form
  const [customAge, setCustomAge] = useState('7');
  const [customSub, setCustomSub] = useState<'' | SubscriptionStatus>('');
  const [customPeriod, setCustomPeriod] = useState('30');
  const [customAutoRenew, setCustomAutoRenew] = useState(true);
  const [customSpend, setCustomSpend] = useState('0');

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/test-users');
    if (res.ok) {
      const body = (await res.json()) as { accounts: TestAccountRow[] };
      setAccounts(body.accounts);
    }
  }, []);

  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch('/api/admin/test-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async function handleCreate(key: string, args: CreateArgs) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const { status, json } = await post({ action: 'create', ...args });
      if (status !== 200) throw new Error((json.error as string) || `Create failed (${status})`);
      const account = json.account as TestAccountRow;
      setCreated({
        email: account.email,
        code: (json.code as string | null) ?? null,
        link: signInLink(account.email),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(null);
    }
  }

  function handleCustom(e: React.FormEvent) {
    e.preventDefault();
    const ageDays = Number(customAge);
    const spendUsd = Number(customSpend);
    const periodEndsInDays = Number(customPeriod);
    const args: CreateArgs = {
      ageDays: Number.isFinite(ageDays) ? Math.trunc(ageDays) : 0,
      subscription: customSub === '' ? null : customSub,
    };
    // Only sent when there is a subscription row to hang them on — the server
    // ignores a period on a null subscription, and sending one anyway makes
    // the request describe an account that cannot exist.
    if (customSub !== '' && Number.isFinite(periodEndsInDays)) {
      args.periodEndsInDays = Math.trunc(periodEndsInDays);
      args.autoRenew = customAutoRenew;
    }
    if (Number.isFinite(spendUsd) && spendUsd > 0) args.spendUsd = spendUsd;
    void handleCreate('custom', args);
  }

  async function showCode(email: string) {
    if (busy) return;
    setBusy(`code:${email}`);
    setError(null);
    try {
      const { status, json } = await post({ action: 'code', email });
      if (status !== 200) throw new Error((json.error as string) || `Failed (${status})`);
      const code = (json.code as string | null) ?? null;
      setDetails((d) => ({
        ...d,
        [email]: {
          code,
          link: signInLink(email),
          note: code ? null : 'No code pending — press New code to send one.',
        },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  async function resendCode(email: string) {
    if (busy) return;
    setBusy(`resend:${email}`);
    setError(null);
    try {
      const { status, json } = await post({ action: 'resend', email });
      const code = (json.code as string | null) ?? null;
      // 429 is not a failure to report as one: the route hands back the code
      // that is STILL VALID alongside the error, so the tester can carry on.
      if (status === 429) {
        setDetails((d) => ({
          ...d,
          [email]: {
            code,
            link: signInLink(email),
            note: 'Too soon for a new code — the previous one below is still valid.',
          },
        }));
        return;
      }
      if (status !== 200) throw new Error((json.error as string) || `Failed (${status})`);
      setDetails((d) => ({
        ...d,
        [email]: { code, link: signInLink(email), note: null },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  async function simpleAction(
    action: 'reset' | 'age' | 'delete',
    email: string,
    extra: Record<string, unknown> = {}
  ) {
    if (busy) return;
    setBusy(`${action}:${email}`);
    setError(null);
    try {
      const { status, json } = await post({ action, email, ...extra });
      if (status !== 200) throw new Error((json.error as string) || `Failed (${status})`);
      if (action === 'delete') {
        setDetails((d) => {
          const next = { ...d };
          delete next[email];
          return next;
        });
        // The created panel is about an account that no longer exists.
        setCreated((c) => (c && c.email === email ? null : c));
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
      setArmedDelete(null);
    }
  }

  /**
   * Two-step click rather than the typed-phrase dialog used for real accounts.
   *
   * The obstruction on `RevokeAccessControl` and `DeleteAccountSection` exists
   * because those destroy something a person owns and cannot get back. These
   * accounts are disposable by construction — no real trips, no real money,
   * and the preset that made this one is a click away — so a confirm step that
   * only prevents a slipped mouse is the honest weight for it.
   */
  function handleDelete(email: string) {
    if (armedDelete === email) {
      void simpleAction('delete', email);
    } else {
      setArmedDelete(email);
    }
  }

  return (
    <>
      {error && (
        <div
          role="alert"
          style={{
            ...card,
            marginBottom: 16,
            background: 'var(--tp-danger-muted)',
            border: '1px solid rgba(198, 93, 74, 0.5)',
            color: 'var(--tp-danger)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {error}
        </div>
      )}

      {/* Everything the loop needs, together, immediately after the click. */}
      {created && (
        <section
          style={{
            ...card,
            marginBottom: 24,
            border: '1px solid var(--tp-primary)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 14,
            }}
          >
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Account ready</h2>
            <button
              type="button"
              onClick={() => setCreated(null)}
              style={{ ...smallBtn, border: 'none', background: 'transparent', color: 'var(--tp-subtle)' }}
            >
              Dismiss
            </button>
          </div>

          <ol
            style={{
              margin: '0 0 16px',
              paddingLeft: 20,
              fontSize: 13,
              color: 'var(--tp-muted)',
              lineHeight: 1.7,
            }}
          >
            <li>Copy the sign-in link.</li>
            <li>Open an incognito window and paste it.</li>
            <li>Type the six-digit code into the form.</li>
            <li>You are signed in as this user. Your own session is untouched.</li>
          </ol>

          <Field label="Sign-in link" value={created.link} emphasis />
          <Field
            label="Code"
            value={created.code ?? ''}
            fallback="Not sent — use New code on the row below."
            big
          />
          <Field label="Email address" value={created.email} />

          <p
            style={{
              fontSize: 11,
              color: 'var(--tp-subtle)',
              margin: '14px 0 0',
              lineHeight: 1.6,
              maxWidth: '80ch',
            }}
          >
            There is no &quot;sign in as this user&quot; button, and there will not be one:
            that would be a sign-in bypass in production to save a browser tab. The code
            above is a real emailed one with its real expiry and attempt limits, checked by
            the real verify form. It is also sitting in the inbox already, since these
            addresses deliver to us.
          </p>
        </section>
      )}

      {/* Create */}
      <section style={{ ...card, marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 4px' }}>Spin one up</h2>
        <p style={{ fontSize: 12, color: 'var(--tp-subtle)', margin: '0 0 14px' }}>
          Each preset creates a brand-new address and sends its code straight away.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: 10,
          }}
        >
          {PRESETS.map((p) => {
            const running = busy === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => handleCreate(p.key, p.args)}
                disabled={busy !== null}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 8,
                  fontFamily: 'inherit',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy && !running ? 0.55 : 1,
                  border: p.primary
                    ? '1px solid var(--tp-primary)'
                    : '1px solid var(--tp-border)',
                  background: p.primary ? 'var(--tp-primary-muted)' : 'var(--tp-bg)',
                  color: 'var(--tp-text)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {running ? 'Creating…' : p.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--tp-subtle)',
                    marginTop: 4,
                    lineHeight: 1.45,
                  }}
                >
                  {p.produces}
                </div>
              </button>
            );
          })}
        </div>

        {/* Anything the presets do not cover. Folded away, because needing it
            is the exception and an open form is the friction being removed. */}
        <details style={{ marginTop: 16 }}>
          <summary
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--tp-primary)',
              cursor: 'pointer',
            }}
          >
            Custom
          </summary>
          <form
            onSubmit={handleCustom}
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 12,
              alignItems: 'end',
            }}
          >
            <div>
              <label style={labelStyle} htmlFor="tu-age">
                Age (days)
              </label>
              <input
                id="tu-age"
                style={inputStyle}
                type="number"
                min={0}
                max={3650}
                value={customAge}
                onChange={(e) => setCustomAge(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="tu-sub">
                Subscription
              </label>
              <select
                id="tu-sub"
                style={inputStyle}
                value={customSub}
                onChange={(e) => setCustomSub(e.target.value as '' | SubscriptionStatus)}
              >
                <option value="">none (trial decides)</option>
                {SUBSCRIPTION_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle} htmlFor="tu-period">
                Period ends in (days)
              </label>
              <input
                id="tu-period"
                style={inputStyle}
                type="number"
                min={-3650}
                max={3650}
                value={customPeriod}
                disabled={customSub === ''}
                onChange={(e) => setCustomPeriod(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="tu-spend">
                Synthetic spend (USD)
              </label>
              <input
                id="tu-spend"
                style={inputStyle}
                type="number"
                min={0}
                max={1000}
                step="0.1"
                value={customSpend}
                onChange={(e) => setCustomSpend(e.target.value)}
              />
            </div>
            <label
              style={{
                fontSize: 12,
                color: 'var(--tp-muted)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={customAutoRenew}
                disabled={customSub === ''}
                onChange={(e) => setCustomAutoRenew(e.target.checked)}
              />
              Auto-renew
            </label>
            <button
              type="submit"
              disabled={busy !== null}
              style={{
                padding: '9px 20px',
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
                borderRadius: 'var(--tp-radius-sm, 8px)',
                border: 'none',
                background: 'var(--tp-primary)',
                color: 'var(--tp-on-primary)',
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy === 'custom' ? 'Creating…' : 'Create'}
            </button>
          </form>
        </details>
      </section>

      {/* List */}
      <section style={card}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
            Existing test accounts
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--tp-subtle)',
              }}
            >
              {accounts.length}
            </span>
          </h2>
          <button type="button" onClick={() => void refresh()} style={smallBtn}>
            Refresh
          </button>
        </div>

        {accounts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
            None yet. Spin one up above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {accounts.map((a) => {
              const detail = details[a.email];
              const armed = armedDelete === a.email;
              return (
                <div
                  key={a.id}
                  style={{
                    border: '1px solid var(--tp-border)',
                    borderRadius: 8,
                    padding: 12,
                    background: 'var(--tp-bg)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      gap: 10,
                      alignItems: 'baseline',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ ...monoStyle, fontSize: 13, fontWeight: 600 }}>
                        {a.email}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--tp-subtle)',
                          marginTop: 4,
                          display: 'flex',
                          gap: 14,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span>{ageInDays(a.createdAt)}d old</span>
                        <span>
                          subscription: {a.subscriptionStatus ?? 'none'}
                        </span>
                        <span>spend: {dollars(a.spendMicrocents)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        style={smallBtn}
                        disabled={busy !== null}
                        onClick={() => void showCode(a.email)}
                      >
                        {busy === `code:${a.email}` ? '…' : 'Show code'}
                      </button>
                      <button
                        type="button"
                        style={smallBtn}
                        disabled={busy !== null}
                        onClick={() => void resendCode(a.email)}
                      >
                        {busy === `resend:${a.email}` ? '…' : 'New code'}
                      </button>
                      <button
                        type="button"
                        style={smallBtn}
                        disabled={busy !== null}
                        onClick={() => void simpleAction('age', a.email, { days: 7 })}
                      >
                        {busy === `age:${a.email}` ? '…' : 'Age to day 7'}
                      </button>
                      <button
                        type="button"
                        style={smallBtn}
                        disabled={busy !== null}
                        onClick={() => void simpleAction('reset', a.email)}
                      >
                        {busy === `reset:${a.email}` ? '…' : 'Reset to day 0'}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => handleDelete(a.email)}
                        onBlur={() => setArmedDelete((k) => (k === a.email ? null : k))}
                        style={{
                          ...smallBtn,
                          border: '1px solid rgba(198, 93, 74, 0.5)',
                          background: armed ? 'var(--tp-danger)' : 'var(--tp-danger-muted)',
                          color: armed ? '#FFFFFF' : 'var(--tp-danger)',
                        }}
                      >
                        {busy === `delete:${a.email}`
                          ? 'Deleting…'
                          : armed
                            ? 'Click again to delete'
                            : 'Delete'}
                      </button>
                    </div>
                  </div>

                  {detail && (
                    <div
                      style={{
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: '1px solid var(--tp-border)',
                      }}
                    >
                      {detail.note && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--tp-muted)',
                            marginBottom: 8,
                          }}
                        >
                          {detail.note}
                        </div>
                      )}
                      {detail.code && (
                        <Field label="Code" value={detail.code} big />
                      )}
                      <Field label="Sign-in link" value={detail.link} emphasis />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

/** A value the admin is meant to copy, sized so it can be read across a desk. */
function Field({
  label,
  value,
  fallback,
  big,
  emphasis,
}: {
  label: string;
  value: string;
  fallback?: string;
  big?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.15em',
          color: 'var(--tp-subtle)',
          marginBottom: 4,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          border: '1px solid var(--tp-border)',
          borderRadius: 8,
          padding: '8px 10px',
          background: 'var(--tp-surface-muted)',
        }}
      >
        <div
          style={{
            ...monoStyle,
            flex: 1,
            minWidth: 0,
            fontSize: big ? 24 : 14,
            fontWeight: big ? 700 : 500,
            letterSpacing: big ? '0.18em' : undefined,
            color: value ? 'var(--tp-text)' : 'var(--tp-subtle)',
          }}
        >
          {value || fallback || '—'}
        </div>
        {value && <CopyButton value={value} emphasis={emphasis} />}
      </div>
    </div>
  );
}
