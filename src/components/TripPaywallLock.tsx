'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import PurchaseSheet from '@/components/PurchaseSheet';
import { blockNoticeFor, type BlockNotice } from '@/lib/paywallCopy';
import type { BlockReason, EntitlementPayload } from '@/types/entitlement';

/**
 * The paywall's version of a locked pane, for the trip workspace.
 *
 * Penny already tells the user what happened, in her own words, in the chat
 * column a few inches away. So this is deliberately NOT a second copy of her
 * message: a kicker, the one-line state, one sentence about what the scrim is
 * doing, and the same button she offers. Reading the same paragraph twice on
 * one screen is how a block starts to feel like nagging.
 *
 * A HOOK rather than a component because the notice is drawn inside every
 * locked pane (two of them on desktop and tablet, two tabs on mobile) while the
 * entitlement fetch, the purchase sheet and the in-flight purchase must exist
 * exactly ONCE. Returning the pieces lets the caller put the notice in each
 * pane and mount the sheet once, without a context or a portal for what is
 * ultimately one boolean and one modal.
 */
export function useTripPaywallLock(blockReason: BlockReason | null): {
  /** True when the itinerary and map panes must be covered. */
  locked: boolean;
  /** Scrim content. Pass to `PaneLock`'s `notice` on every pane that should explain itself. */
  notice: ReactNode;
  /** Mount ONCE anywhere in the tree — it is fixed-position and self-centring. */
  sheet: ReactNode;
} {
  const notice = blockReason ? blockNoticeFor(blockReason) : null;
  const selling = notice?.tone === 'sell';

  /**
   * Prices, fetched only when there is something to sell. The LOCK itself never
   * waits on this: the server already decided it for this render and passed it
   * down, so there is no window in which the panes look usable before we take
   * them away. A failed fetch is silent — the sheet still opens and becomes
   * what it already is for every non-allowlisted account, the prices' home
   * address on iPhone.
   */
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const fetchEntitlement = useCallback(async (): Promise<EntitlementPayload | null> => {
    try {
      // Raw fetch, not apiFetch: not knowing the prices is not an error worth
      // putting a toast in front of someone who has done nothing wrong.
      const res = await fetch('/api/me/entitlement', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as EntitlementPayload;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!selling) return;
    let cancelled = false;
    void (async () => {
      const payload = await fetchEntitlement();
      if (!cancelled && payload) setEntitlement(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [selling, fetchEntitlement]);

  const runTestPurchase = useCallback(
    async (productId: string) => {
      setPurchasingId(productId);
      setPurchaseError(null);
      try {
        const res = await fetch('/api/purchase/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Purchase failed (${res.status})`);
        }
        // The grant is only real once the entitlement endpoint agrees. Believing
        // the 200 would lift the scrim on our own say-so.
        const fresh = await fetchEntitlement();
        if (!fresh?.entitled) {
          setPurchaseError(
            "That went through, but your plan hasn't switched on yet. Give it a moment and reload.",
          );
          return;
        }
        // The lock was resolved on the server for this render, so the page has
        // to be asked again — there is no client state that could unlock it.
        window.location.reload();
      } catch (e: unknown) {
        setPurchaseError(e instanceof Error ? e.message : String(e));
      } finally {
        setPurchasingId(null);
      }
    },
    [fetchEntitlement],
  );

  return {
    locked: blockReason !== null,
    notice: blockReason && notice ? (
      <LockNotice
        notice={notice}
        blockReason={blockReason}
        selling={selling}
        onAction={() => {
          setPurchaseError(null);
          setSheetOpen(true);
        }}
        error={purchaseError}
      />
    ) : null,
    sheet:
      sheetOpen && blockReason ? (
        <PurchaseSheet
          products={entitlement?.products ?? []}
          testPurchaseAllowed={entitlement?.testPurchaseAllowed ?? false}
          purchasingId={purchasingId}
          error={purchaseError}
          onPurchase={(id) => void runTestPurchase(id)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null,
  };
}

/**
 * What the scrim says. One sentence about the panes underneath it, because that
 * is the only thing on this screen Penny has not already covered — she has no
 * way to know the map went quiet.
 *
 * The same line for every reason: the nuance between "your trial ended" and "we
 * paused this account" belongs in her message, and the difference the scrim
 * actually cares about is the same in all four cases.
 */
const LOCK_LINE =
  'Your trip is still here to look at. Opening a day and moving the map are paused — Penny is still in the chat.';

function LockNotice({
  notice,
  blockReason,
  selling,
  onAction,
  error,
}: {
  notice: BlockNotice;
  /** Verbatim on the root node, so a test can assert WHICH block a pane is under. */
  blockReason: BlockReason;
  selling: boolean;
  onAction: () => void;
  error: string | null;
}) {
  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '9px 16px',
    borderRadius: 'var(--tp-radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    textDecoration: 'none',
    cursor: 'pointer',
    background: selling ? 'var(--tp-primary)' : 'transparent',
    color: selling ? 'var(--tp-on-primary)' : 'var(--tp-primary)',
    border: selling ? 'none' : '1px solid var(--tp-border-strong)',
  };

  return (
    /*
      A note, not a dialog. `role="dialog"` + `aria-modal` would claim the whole
      page is behind this — and it is not: the chat column beside it is live and
      is the one thing we want the user to reach.
    */
    <section
      data-testid="trip-pane-lock"
      data-block-reason={blockReason}
      aria-label={notice.heading}
      style={{
        width: '100%',
        maxWidth: 340,
        background: 'var(--tp-surface)',
        border: '1px solid var(--tp-border-strong)',
        borderRadius: 'var(--tp-radius-md)',
        boxShadow: 'var(--tp-shadow-md)',
        padding: 20,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.15em',
          color: selling ? 'var(--tp-primary)' : 'var(--tp-muted)',
          marginBottom: 6,
        }}
      >
        {notice.eyebrow}
      </div>

      <h2 style={{ margin: 0, marginBottom: 8, fontSize: 16, fontWeight: 700, color: 'var(--tp-text)' }}>
        {notice.heading}
      </h2>

      <p style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--tp-muted)' }}>
        {LOCK_LINE}
      </p>

      {/*
        One element, whatever happens — an <a> that becomes a <button> when a
        fetch lands is a trap: click it in that window and the user is on the
        App Store instead of the sheet. A capped account gets the mailto,
        because there is nothing to sell them.
      */}
      {selling ? (
        <button type="button" data-testid="trip-pane-lock-cta" onClick={onAction} style={buttonStyle}>
          {notice.action.label}
        </button>
      ) : (
        <a href={notice.action.href} data-testid="trip-pane-lock-support" style={buttonStyle}>
          {notice.action.label}
        </a>
      )}

      {error && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--tp-danger)' }}>
          {error}
        </p>
      )}
    </section>
  );
}
