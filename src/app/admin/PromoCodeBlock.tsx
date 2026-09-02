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
 * WHAT MINTING DOES, as of 2026-09-02 — this changed, and the old rule is worth
 * knowing because it was stated here as an invariant:
 *
 * It used to grant nothing at all. The row sat in `promo_codes` and the
 * recipient had to sign in, find a purchase sheet and paste the code in
 * themselves. That is a step you have to explain in the same email you send the
 * code in, and a step that fails silently if they mistype it.
 *
 * Now the code CLAIMS ITSELF on sign-in: `claimPromoOnSignIn` runs on both
 * sign-in paths, finds an unredeemed, unexpired code bound to that address, and
 * redeems it. So minting for somebody who has not signed up yet is now enough —
 * you send them the address you minted for, they sign in, they are on the plan.
 *
 * WHAT HAS NOT CHANGED, and is the part that mattered: an admin still cannot
 * hand out access without the recipient completing a real sign-in as the bound
 * address. There is still no "grant access to this user" button. The claim goes
 * through the same `redeemPromoCode` and the same atomic
 * `UPDATE ... WHERE redeemed_at IS NULL`, so a code is still single-use and two
 * concurrent sign-ins cannot both win it. And it still writes an ordinary
 * `subscriptions` row — nothing in the paywall path reads `promo_codes`.
 *
 * The manual box in both purchase sheets stays, as the fallback for the common
 * case: somebody who signed up with a different address than the one you minted
 * for.
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
  grantMonths: number;
}

export default function PromoCodeBlock({ paywallOn }: { paywallOn: boolean }) {
  const [rows, setRows] = useState<PromoRow[]>([]);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  // No default. A term is a decision, and a select that arrives pre-answered is
  // one an admin can submit without making it.
  const [grantMonths, setGrantMonths] = useState('');
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
    if (busy || !email.trim() || !grantMonths) return;
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
          grantMonths: Number(grantMonths),
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
      setGrantMonths('');
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
        Issues one code, bound to one address, for the length of access you pick.
        The recipient signs in with that address and it applies itself — they do
        not have to type it — and nobody else can redeem it. The term runs from
        when they redeem, not from now; the ordinary usage ceiling still applies.
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
        {/*
          TWO DIFFERENT DURATIONS, and the labels carry the whole distinction.
          "expires (days)" alone was survivable while it was the only time field
          on the form; next to a term it is a real mistake waiting to happen —
          an admin reading it as "how long they get" would mint a code that
          grants a year and dies in seven days.
        */}
        <input
          data-testid="promo-admin-expires"
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value.replace(/\D/g, ''))}
          placeholder="code expires in (days)"
          inputMode="numeric"
          disabled={busy}
          style={{ ...field, flex: '1 1 150px' }}
          title="Deadline to REDEEM the code. Blank = never goes stale. Not the length of access."
        />
        <select
          data-testid="promo-admin-months"
          value={grantMonths}
          onChange={(e) => setGrantMonths(e.target.value)}
          disabled={busy}
          style={{ ...field, flex: '1 1 130px' }}
          title="How long the access lasts, counted from when they redeem it."
        >
          <option value="">access…</option>
          <option value="6">access: 6 months</option>
          <option value="12">access: 12 months</option>
        </select>
        <button
          data-testid="promo-admin-mint"
          onClick={() => void mint()}
          disabled={busy || !email.trim() || !grantMonths}
          style={{
            padding: '9px 16px',
            borderRadius: 'var(--tp-radius-sm)',
            border: 'none',
            background: busy || !email.trim() || !grantMonths ? 'var(--tp-border)' : 'var(--tp-primary)',
            color: busy || !email.trim() || !grantMonths ? 'var(--tp-subtle)' : 'var(--tp-on-primary)',
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
            For {minted.email} · {minted.grantMonths} months of access
            {minted.expiresAt
              ? ` · redeem before ${new Date(minted.expiresAt).toLocaleDateString()}`
              : ' · code never expires'}
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
  const term = `${r.grantMonths}mo`;
  if (r.redeemedAt) {
    const who = r.redeemedByEmail ? ` by ${r.redeemedByEmail}` : ' (account since deleted)';
    /**
     * Computed here rather than read off the subscription row, deliberately.
     * The term runs from redemption and this component already knows both
     * halves; joining `subscriptions` to show it would make the admin list
     * depend on a table it otherwise never touches, for a date it can derive.
     * It is the same arithmetic `promoGrant` did — if the two ever disagree,
     * the subscription row is the truth.
     */
    const redeemed = new Date(r.redeemedAt);
    const ends = new Date(redeemed);
    ends.setMonth(ends.getMonth() + r.grantMonths);
    return `Redeemed ${redeemed.toLocaleDateString()}${who} · access ends ${ends.toLocaleDateString()}`;
  }
  if (r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()) {
    return `Expired, unused · ${term}`;
  }
  return r.expiresAt
    ? `Unused · ${term} · code expires ${new Date(r.expiresAt).toLocaleDateString()}`
    : `Unused · ${term}`;
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
