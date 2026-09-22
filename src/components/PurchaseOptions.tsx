'use client';

import { useState } from 'react';
import { APP_STORE_CTA_LABEL, APP_STORE_URL } from '@/lib/paywallCopy';
import { PROMO_CTA_LABEL, PROMO_PLACEHOLDER, PROMO_PROMPT } from '@/lib/promoCopy';

/**
 * What the web can offer an account it will not let plan: get the app, or
 * redeem a code. A plain block, not a dialog.
 *
 * It exists so the two surfaces that offer this cannot drift. `PurchaseSheet`
 * wraps it in a modal for the triggers that are inline (Penny's bubble, the
 * pane scrim); `EntitlementOverlay` renders it directly inside its own card,
 * because that card is already the dialog and a sheet opened on top of it was
 * two stacked modals saying one thing.
 *
 * It shows no prices: a plan is bought in the iPhone app. (Until 2026-09-21 an
 * allowlisted account saw price rows here that granted access through a fake
 * purchase; that path was removed with `/api/purchase/test`, because the
 * RevenueCat webhook is the only thing that may grant access.)
 */
export default function PurchaseOptions({
  onRedeemed,
}: {
  /**
   * Called after the server has CONFIRMED the account is entitled, not when the
   * redeem request returns 200. The caller decides what to do about it — the
   * overlay reloads (its verdict was resolved server-side for that render),
   * chat re-fetches. Optional so a surface rendered without a promo path simply
   * does not offer one.
   */
  onRedeemed?: () => void;
}) {
  return (
    <>
      <div data-testid="purchase-sheet-iphone-notice">
        {/* Small and quiet: it explains the button, it is not the pitch.
            The pitch already happened in Penny's message or on the block
            notice around this. */}
        <p
          style={{
            margin: '0 0 10px',
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--tp-muted, #5C5C5C)',
          }}
        >
          Plans are bought in the Feral Travels app on iPhone. Everything
          you plan there shows up here.
        </p>
        <a
          data-testid="purchase-sheet-app-store-link"
          href={APP_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 14px',
            borderRadius: 'var(--tp-radius-sm, 8px)',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            background: 'var(--tp-primary, #4E7AB0)',
            color: 'var(--tp-on-primary, #fff)',
          }}
        >
          {APP_STORE_CTA_LABEL}
        </a>
      </div>

      {/* The code field sits under the primary action: most people who
          reach this are getting the app, and the comped few were told
          to look for a field, which this is. */}
      {onRedeemed && <PromoRedeemer onRedeemed={onRedeemed} />}
    </>
  );
}

/**
 * The other way through: a code, instead of the app.
 *
 * It sits under the primary action rather than above it because it is the
 * minority path — most people who see this are getting the app — but it
 * is a peer of it, not a footnote, which is why it gets a real field and a real
 * button rather than a "have a code?" link that expands into one. A disclosure
 * triangle in front of the one control a comped user was told to look for is a
 * small cruelty.
 *
 * It renders a text box and reports success upward. It does not decide what a
 * code is worth, whether this account may redeem one, or what happens next: the
 * server refuses on its own authority, and entitlement is re-read from
 * `/api/me/entitlement` before anything is unblocked.
 */
function PromoRedeemer({ onRedeemed }: { onRedeemed: () => void }) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = pending || code.trim().length === 0;

  async function submit() {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/promo/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        // The server sends copy per refusal code. Rendered verbatim: it already
        // says the useful thing (which address, or that the code is spent), and
        // a client that reworded it would be a second place to keep in step.
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not redeem that code (${res.status})`);
      }
      // Ask, do not assume. A 200 means the row was written; entitlement is a
      // separate question and the server is the one that answers it.
      const fresh = await fetch('/api/me/entitlement', { cache: 'no-store' });
      const payload = fresh.ok ? ((await fresh.json()) as { entitled?: boolean }) : null;
      if (!payload?.entitled) {
        setError("That worked, but your plan hasn't switched on yet. Give it a moment and reload.");
        return;
      }
      onRedeemed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="promo-redeemer" style={{ marginTop: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '0 0 8px',
        }}
      >
        <div style={{ height: 1, flex: 1, background: 'var(--tp-border, #E6DFD4)' }} />
        <span style={{ fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--tp-subtle, #999)' }}>
          {PROMO_PROMPT.toUpperCase()}
        </span>
        <div style={{ height: 1, flex: 1, background: 'var(--tp-border, #E6DFD4)' }} />
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          data-testid="promo-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits. This is a one-field form and reaching for the mouse
            // to finish typing a code is friction with nothing to buy it.
            if (e.key === 'Enter') void submit();
          }}
          placeholder={PROMO_PLACEHOLDER}
          aria-label="Promo code"
          disabled={pending}
          // `characters` rather than uppercasing the value: rewriting what
          // someone is typing moves the caret and fights an iOS keyboard. The
          // server normalizes anyway, so the display form is cosmetic.
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: 'border-box',
            padding: '9px 10px',
            borderRadius: 'var(--tp-radius-sm, 8px)',
            border: '1px solid var(--tp-border, #E6DFD4)',
            background: 'var(--tp-surface-muted, #FBF8F3)',
            color: 'var(--tp-text, #333)',
            fontSize: 13,
            fontFamily: 'inherit',
            textTransform: 'uppercase',
          }}
        />
        <button
          data-testid="promo-submit"
          onClick={() => void submit()}
          disabled={disabled}
          style={{
            padding: '9px 14px',
            borderRadius: 'var(--tp-radius-sm, 8px)',
            border: 'none',
            background: disabled ? 'var(--tp-border, #E6DFD4)' : 'var(--tp-primary, #4E7AB0)',
            color: disabled ? 'var(--tp-subtle, #999)' : 'var(--tp-on-primary, #fff)',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: disabled ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {pending ? 'Checking…' : PROMO_CTA_LABEL}
        </button>
      </div>

      {error && (
        <p
          data-testid="promo-error"
          role="alert"
          style={{
            margin: '8px 0 0',
            fontSize: 11.5,
            lineHeight: 1.45,
            color: 'var(--tp-danger, #C65D4A)',
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
