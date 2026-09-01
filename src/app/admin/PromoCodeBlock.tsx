'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Mint a promo code for one person, from the admin page.
 *
 * The flow this serves is a conversation: somebody emails asking for access,
 * you paste their address in here, you get a code back, you send it to them.
 * That is the whole feature, and the UI is shaped to be finished in one screen
 * — no navigation, no confirmation step, and the code readable the instant it
 * exists, because the next thing you do is copy it into a reply.
 *
 * WHAT IT DOES NOT DO: grant anything by itself. Minting writes a row in
 * `promo_codes` and nothing else. The account becomes entitled only when the
 * person signs in as the bound address and redeems it themselves — which is why
 * there is no "grant access to this user" button here and no way for an admin to
 * hand out access without the recipient completing a real sign-in.
 *
 * There is also no delete and no revoke. An unspent code that should not have
 * gone out is handled by not sending it; a spent one is a subscription, and
 * subscriptions end through the break-glass revoke on the user's own admin page,
 * which demands a typed reason and records who pressed it. A second, quieter
 * path to taking access away is not something this block should introduce.
 */

interface PromoRow {
  id: string;
  code: string;
  display: string;
  email: string;
  note: string | null;
  createdBy: string;
  expiresAt: string | null;
  redeemedAt: string | null;
  createdAt: string;
  redeemedByEmail: string | null;
}

export default function PromoCodeBlock({ paywallOn }: { paywallOn: boolean }) {
  const [rows, setRows] = useState<PromoRow[]>([]);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<PromoRow | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/promo', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Could not load codes (${res.status})`);
      const data = (await res.json()) as { codes: PromoRow[] };
      setRows(data.codes);
    } catch (e: unknown) {
      // Surfaced, never swallowed — the repo's rule, and a silently empty list
      // here reads as "no codes have ever been issued", which is a different
      // and much more alarming fact than "the fetch failed".
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch('/api/admin/promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          email: email.trim(),
          note: note.trim() || undefined,
          expiresInDays: expiresInDays.trim() ? Number(expiresInDays) : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not mint a code (${res.status})`);
      }
      const data = (await res.json()) as { code: PromoRow };
      setMinted(data.code);
      setEmail('');
      setNote('');
      setExpiresInDays('');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--tp-text)' }}>
        Promo codes
      </h2>
      <p style={{ fontSize: 12, color: 'var(--tp-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
        Issues one code, bound to one address. The recipient signs in with that
        address and redeems it in the app — it grants nothing on its own, and it
        cannot be redeemed by anyone else. Access is unlimited and has no renewal
        date; the ordinary usage ceiling still applies.
      </p>

      {/*
        The same warning `TestUserBlock` carries, for the same afternoon-shaped
        reason: with PAYWALL_ENABLED unset, `applySwitch` rewrites every verdict
        to entitled, so a redeemed code changes nothing observable and the
        feature reads as broken when it is working perfectly.
      */}
      {!paywallOn && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            borderRadius: 'var(--tp-radius-sm)',
            background: 'rgba(212, 160, 23, 0.12)',
            border: '1px solid rgba(212, 160, 23, 0.35)',
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--tp-text)',
          }}
        >
          <strong>The paywall is switched off here.</strong> Codes still mint and
          still redeem, but nobody is blocked in the first place, so redeeming one
          will look like it did nothing. Set <code>PAYWALL_ENABLED=1</code> to see
          it work.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
        <input
          data-testid="promo-admin-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="their@email.com"
          disabled={busy}
          style={{ ...field, flex: '2 1 220px' }}
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (who, why)"
          disabled={busy}
          style={{ ...field, flex: '2 1 180px' }}
        />
        <input
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value.replace(/\D/g, ''))}
          placeholder="expires (days)"
          inputMode="numeric"
          disabled={busy}
          style={{ ...field, flex: '1 1 110px' }}
        />
        <button
          data-testid="promo-admin-mint"
          onClick={() => void mint()}
          disabled={busy || !email.trim()}
          style={{
            padding: '9px 16px',
            borderRadius: 'var(--tp-radius-sm)',
            border: 'none',
            background: busy || !email.trim() ? 'var(--tp-border)' : 'var(--tp-primary)',
            color: busy || !email.trim() ? 'var(--tp-subtle)' : 'var(--tp-on-primary)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: busy || !email.trim() ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Minting…' : 'Mint code'}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}

      {/* Big, monospaced and copyable. The next action is always "paste this
          into a reply", so the code is the largest thing on screen. */}
      {minted && (
        <div
          data-testid="promo-admin-minted"
          style={{
            marginTop: 12,
            padding: '12px 14px',
            borderRadius: 'var(--tp-radius-sm)',
            background: 'var(--tp-success-muted, rgba(74, 139, 122, 0.12))',
            border: '1px solid rgba(74, 139, 122, 0.35)',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--tp-muted)', marginBottom: 6 }}>
            For {minted.email}
            {minted.expiresAt
              ? ` · redeem before ${new Date(minted.expiresAt).toLocaleDateString()}`
              : ' · no expiry'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <code style={{ fontSize: 19, fontWeight: 700, letterSpacing: '0.04em' }}>
              {minted.display}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(minted.display).then(() => setCopied(true));
              }}
              style={{
                padding: '5px 10px',
                borderRadius: 'var(--tp-radius-sm)',
                border: '1px solid var(--tp-border-strong)',
                background: 'transparent',
                color: 'var(--tp-primary)',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--tp-subtle)' }}>
                <th style={cell}>Code</th>
                <th style={cell}>Issued to</th>
                <th style={cell}>Note</th>
                <th style={cell}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--tp-border)' }}>
                  <td style={cell}>
                    <code>{r.display}</code>
                  </td>
                  <td style={cell}>{r.email}</td>
                  <td style={{ ...cell, color: 'var(--tp-muted)' }}>{r.note ?? '—'}</td>
                  <td style={cell}>{statusOf(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Three states, and the redeemed one names WHO spent it.
 *
 * That last part is the only reason the list joins to `users`. Redemption
 * compares the session's address against the code's, so the two should always
 * match — printing the redeemer's address is how you confirm at a glance that
 * the binding actually held, rather than trusting that it did. "(account since
 * deleted)" is the other real case: the row survives the user on purpose, so a
 * spent code never looks mintable again.
 */
function statusOf(r: PromoRow): string {
  if (r.redeemedAt) {
    const who = r.redeemedByEmail ? ` by ${r.redeemedByEmail}` : ' (account since deleted)';
    return `Redeemed ${new Date(r.redeemedAt).toLocaleDateString()}${who}`;
  }
  if (r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()) return 'Expired, unused';
  return r.expiresAt
    ? `Unused · expires ${new Date(r.expiresAt).toLocaleDateString()}`
    : 'Unused';
}

const field: React.CSSProperties = {
  padding: '9px 10px',
  borderRadius: 'var(--tp-radius-sm)',
  border: '1px solid var(--tp-border)',
  background: 'var(--tp-surface)',
  color: 'var(--tp-text)',
  fontSize: 13,
  fontFamily: 'inherit',
  minWidth: 0,
};

const cell: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'top' };
