'use client';

import PurchaseOptions from '@/components/PurchaseOptions';
import type { BlockNotice } from '@/lib/paywallCopy';
import type { BlockReason } from '@/types/entitlement';

/**
 * The block, as something laid OVER the page rather than a card wedged above it.
 *
 * The notice used to sit in the flow with the trip list live underneath it,
 * which was a soft block: read anything, change nothing. It is now hard — the
 * page behind is visible and inert. Visible matters. A driver two weeks into a
 * route who let a card lapse should be able to see the plan sitting there,
 * because "this is still yours, it is paused" and "your trips are gone" are
 * very different messages and only one of them is true.
 *
 * NOTE: this reverses "Allowed: viewing existing trips" in
 * docs/design/subscriptions.md, at the owner's instruction. The doc is
 * deliberately left alone — one of the two is now out of date and that is his
 * call, not this component's.
 *
 * Client, unlike `EntitlementNotice` which renders it, because a selling block
 * carries `PurchaseOptions` inline — the same block the purchase sheet behind
 * Penny's bubble renders, so the two surfaces cannot drift into offering
 * different things. Inline, not a sheet opened from a button: this card is
 * already the dialog, and a sheet on top of it was two stacked modals.
 *
 * There is no link to Penny from here, for any reason. A blocked account's
 * composer is disabled and `/api/trip/replan` 402s, so "Talk to Penny" under a
 * body that says Penny is paused was a dead end.
 */
export default function EntitlementOverlay({
  blockReason,
  notice,
}: {
  /** Verbatim on the root node — `e2e/subscriptions.spec.ts` reads it. */
  blockReason: BlockReason;
  notice: BlockNotice;
}) {
  const selling = notice.tone === 'sell';

  const quietLinkStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--tp-primary)',
    textDecoration: 'none',
  };

  // Only the apologetic branch draws its own button (the mailto); a selling
  // block's primary action is the App Store link inside PurchaseOptions.
  const supportButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px 18px',
    borderRadius: 'var(--tp-radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    textDecoration: 'none',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--tp-primary)',
    border: '1px solid var(--tp-border-strong)',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={notice.heading}
      data-testid="entitlement-overlay"
      data-block-reason={blockReason}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        // The page underneath stays readable through this. That is the point:
        // covered, not deleted.
        background: 'var(--tp-overlay, rgba(51, 51, 51, 0.4))',
      }}
    >
      <section
        data-testid="entitlement-overlay-card"
        style={{
          width: '100%',
          maxWidth: 460,
          maxHeight: '100%',
          overflowY: 'auto',
          background: 'var(--tp-surface)',
          border: `1px solid ${selling ? 'rgba(78, 122, 176, 0.35)' : 'var(--tp-border-strong)'}`,
          borderRadius: 'var(--tp-radius-md)',
          padding: 24,
          boxShadow: 'var(--tp-shadow-md)',
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

        <h2 style={{ margin: 0, marginBottom: 10, fontSize: 18, fontWeight: 700, color: 'var(--tp-text)' }}>
          {notice.heading}
        </h2>

        {notice.body.map((paragraph) => (
          <p
            key={paragraph.slice(0, 24)}
            style={{
              margin: '0 0 10px',
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--tp-muted)',
            }}
          >
            {paragraph}
          </p>
        ))}

        {selling && (
          <div style={{ marginTop: 14 }}>
            <PurchaseOptions
              // A reload, because this page's verdict was resolved on the server
              // for this render, so there is no client state that could unblock it.
              onRedeemed={() => window.location.reload()}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 14 }}>
          {/*
            A capped or revoked account gets the mailto — there is nothing to
            sell them, so no purchase options either.
          */}
          {!selling && (
            <a href={notice.action.href} data-testid="entitlement-overlay-cta" style={supportButtonStyle}>
              {notice.action.label}
            </a>
          )}

          {/*
            The overlay covers the navbar too, so this is the only way to the
            account menu from here — and Settings holds sign-out and account
            deletion. Neither may ever sit behind a paywall: `/settings` is in
            PAYWALL_EXEMPT_PREFIXES for the same reason.
          */}
          <a href="/settings" data-testid="entitlement-overlay-settings" style={quietLinkStyle}>
            Account settings
          </a>
        </div>
      </section>
    </div>
  );
}
