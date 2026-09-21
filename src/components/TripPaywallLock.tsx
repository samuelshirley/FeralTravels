'use client';

import { useState, type ReactNode } from 'react';
import PurchaseSheet from '@/components/PurchaseSheet';
import { blockNoticeFor, type BlockNotice } from '@/lib/paywallCopy';
import type { BlockReason } from '@/types/entitlement';

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
 * purchase sheet must exist exactly ONCE. Returning the pieces lets the caller put the notice in each
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

  // No entitlement fetch: the web sheet shows no prices (a plan is bought in
  // the iPhone app), so there is nothing to ask the server for. It used to
  // fetch one for the allowlisted fake purchase, removed on 2026-09-21.
  const [sheetOpen, setSheetOpen] = useState(false);

  return {
    locked: blockReason !== null,
    notice: blockReason && notice ? (
      <LockNotice
        notice={notice}
        blockReason={blockReason}
        selling={selling}
        onAction={() => setSheetOpen(true)}
      />
    ) : null,
    sheet:
      sheetOpen && blockReason ? (
        <PurchaseSheet onClose={() => setSheetOpen(false)} />
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
}: {
  notice: BlockNotice;
  /** Verbatim on the root node, so a test can assert WHICH block a pane is under. */
  blockReason: BlockReason;
  selling: boolean;
  onAction: () => void;
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
    </section>
  );
}
