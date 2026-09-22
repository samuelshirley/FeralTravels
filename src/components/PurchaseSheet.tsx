'use client';

import { useEffect } from 'react';
import PurchaseOptions from '@/components/PurchaseOptions';

/**
 * The purchase sheet: the modal Penny's bubble and the pane scrim open.
 *
 * Penny's paywall lives in the transcript as a message, deliberately: a sheet
 * thrown over the app on launch is the thing we are not doing. But a purchase
 * IS a modal everywhere else on the platform — on iPhone this is replaced
 * wholesale by Apple's StoreKit sheet, which is modal, dismissible and stops
 * the world. Matching that shape here means the web flow and the native flow
 * are the same flow, and the day StoreKit lands this component is deleted
 * rather than redesigned.
 *
 * Sizing follows from that. StoreKit's sheet is a small card that names a
 * price and gets out of the way; on a desktop viewport this one has to stay
 * that size on purpose, because a purchase card that grows to fill the window
 * stops reading as a sheet and starts reading as a pricing page — which is a
 * different, pushier product than the one we are shipping. Hence the hard
 * SHEET_MAX_WIDTH ceiling, the viewport-capped height, and the tight vertical
 * rhythm below: every gap here is the smallest one that still separates.
 *
 * What it offers is `PurchaseOptions`, shared with the block overlay, which
 * renders the same block inline: that overlay is already a dialog, and opening
 * this sheet on top of it was two stacked modals. This one stays for the
 * triggers that are inline — Penny's bubble and the pane scrim.
 */

/**
 * Roughly the width of Apple's own sheet. Wider than this and the card stops
 * reading as a sheet and starts reading as a page.
 */
const SHEET_MAX_WIDTH = 380;

export default function PurchaseSheet({
  onClose,
  onRedeemed,
}: {
  onClose: () => void;
  /**
   * Called after the server has CONFIRMED the account is entitled, not when the
   * redeem request returns 200. The caller decides what to do about it — the
   * overlay reloads (its verdict was resolved server-side for that render),
   * chat re-fetches. Optional so a sheet rendered without a promo path simply
   * does not offer one.
   */
  onRedeemed?: () => void;
}) {
  // Escape closes, like Apple's sheet and like every other overlay the user has
  // ever met.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid="purchase-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Get the app"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--tp-overlay, rgba(51, 51, 51, 0.4))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: 20,
      }}
    >
      <div
        data-testid="purchase-sheet"
        // The overlay closes on click; the card must not, or every tap on a
        // price would dismiss the thing the user is trying to read.
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--tp-surface, #fff)',
          borderRadius: 'var(--tp-radius-md, 12px)',
          border: '1px solid var(--tp-border, #E6DFD4)',
          boxShadow: 'var(--tp-shadow-md, 0 4px 12px rgba(51, 51, 51, 0.08))',
          width: '100%',
          maxWidth: SHEET_MAX_WIDTH,
          // A sheet never scrolls the page behind it, and never grows taller
          // than the window: whatever it holds, it stays a card.
          maxHeight: 'calc(100vh - 40px)',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        <div
          style={{
            height: 3,
            background:
              'linear-gradient(90deg, var(--tp-primary, #4E7AB0), var(--tp-accent-warm, #C97B63))',
          }}
        />

        <div style={{ padding: '18px 20px 20px' }}>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              width: 26,
              height: 26,
              border: 'none',
              background: 'transparent',
              color: 'var(--tp-subtle, #999)',
              fontSize: 19,
              lineHeight: '26px',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            ×
          </button>

          {/* Title and subtitle are one block, not two — 2px apart, so they
              read as a single heading and what follows starts immediately. */}
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--tp-text, #333)',
              margin: '0 0 12px',
              paddingRight: 24,
            }}
          >
            Feral Travels
          </h2>

          <PurchaseOptions onRedeemed={onRedeemed} />

        </div>
      </div>
    </div>
  );
}
