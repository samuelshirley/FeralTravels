'use client';

import { useEffect } from 'react';
import Spinner from '@/components/Spinner';
import { APP_STORE_CTA_LABEL, APP_STORE_URL } from '@/lib/paywallCopy';
import type { PaywallProduct } from '@/types/entitlement';

/**
 * The purchase sheet — and the ONLY modal in the paywall flow.
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
 * It renders prices it was handed. It does not decide who can buy, what a
 * plan costs, or whether the fake-purchase path is available — all three come
 * from `GET /api/me/entitlement`, and the server refuses the purchase again on
 * its own authority regardless of what this sheet chose to show.
 */

/**
 * Roughly the width of Apple's own sheet, and narrow enough that the two price
 * rows read as a short list rather than as full-bleed banners. Wider than this
 * and the rows stretch, the prices drift away from their cadence labels, and
 * the whole card loses the "one small decision" shape.
 */
const SHEET_MAX_WIDTH = 380;

export default function PurchaseSheet({
  products,
  testPurchaseAllowed,
  purchasingId,
  error,
  onPurchase,
  onClose,
}: {
  products: PaywallProduct[];
  /**
   * Server's answer, never the client's guess. False means this browser is not
   * a purchase surface at all — the sheet then shows the prices and points at
   * the iPhone app, because a button that cannot take money is worse than no
   * button.
   */
  testPurchaseAllowed: boolean;
  /** Product id currently in flight, or null. */
  purchasingId: string | null;
  error: string | null;
  onPurchase: (productId: string) => void;
  onClose: () => void;
}) {
  const busy = purchasingId !== null;

  // Escape closes, like Apple's sheet and like every other overlay the user has
  // ever met. Skipped while a grant is in flight — dismissing mid-request would
  // leave the account paid up and the UI still paywalled until a reload.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      data-testid="purchase-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a plan"
      onClick={() => {
        if (!busy) onClose();
      }}
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
            disabled={busy}
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
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            ×
          </button>

          {/* Title and subtitle are one block, not two — 2px apart, so they
              read as a single heading and the prices start immediately. */}
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'var(--tp-text, #333)',
              margin: '0 0 2px',
              paddingRight: 24,
            }}
          >
            Feral Travels
          </h2>
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--tp-muted, #5C5C5C)',
              margin: '0 0 14px',
            }}
          >
            Choose a plan
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {products.map((p) => (
              <PlanRow
                key={p.id}
                product={p}
                // Only an allowlisted account gets a pressable row. Everyone
                // else reads the same prices and buys on the phone.
                actionable={testPurchaseAllowed}
                busy={busy}
                pending={purchasingId === p.id}
                onSelect={() => onPurchase(p.id)}
              />
            ))}
          </div>

          {testPurchaseAllowed ? (
            <div
              data-testid="purchase-sheet-test-notice"
              style={{
                marginTop: 12,
                padding: '7px 9px',
                background: 'rgba(212, 160, 23, 0.12)',
                border: '1px solid rgba(212, 160, 23, 0.35)',
                borderRadius: 'var(--tp-radius-sm, 8px)',
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--tp-text, #333)',
              }}
            >
              {/* Loud on purpose. This path grants paid access with no payment,
                  and the one place that must be unmistakable is a screenshot of
                  the sheet that granted it. */}
              <strong>Test purchase — no payment.</strong> Your account is
              allowlisted, so picking a plan grants it directly and logs a{' '}
              <code style={{ fontSize: 10.5 }}>FAKE_PURCHASE</code> event. No
              money moves.
            </div>
          ) : (
            <div data-testid="purchase-sheet-iphone-notice" style={{ marginTop: 12 }}>
              {/* Small and quiet, sitting under the prices: it explains the
                  button, it is not the pitch. The pitch already happened in
                  Penny's message or on the block notice that opened this. */}
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
          )}

          {error && (
            <div
              data-testid="purchase-sheet-error"
              style={{
                marginTop: 10,
                padding: '7px 9px',
                background: 'var(--tp-danger-muted, rgba(198, 93, 74, 0.12))',
                border: '1px solid rgba(198, 93, 74, 0.35)',
                borderRadius: 'var(--tp-radius-sm, 8px)',
                fontSize: 11.5,
                lineHeight: 1.45,
                color: 'var(--tp-danger, #C65D4A)',
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One price. Pressable only where a purchase can actually be completed. */
function PlanRow({
  product,
  actionable,
  busy,
  pending,
  onSelect,
}: {
  product: PaywallProduct;
  actionable: boolean;
  busy: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--tp-text, #333)' }}>
          {product.priceLabel}
        </span>
        <span style={{ fontSize: 12, color: 'var(--tp-muted, #5C5C5C)' }}>
          {product.cadence}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {product.note && (
          <span
            style={{
              padding: '2px 7px',
              borderRadius: 999,
              background: 'var(--tp-success-muted, rgba(74, 139, 122, 0.14))',
              color: 'var(--tp-success, #4A8B7A)',
              fontSize: 10.5,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {product.note}
          </span>
        )}
        {pending && <Spinner size={12} thickness={2} color="var(--tp-primary)" />}
      </div>
    </>
  );

  const frame: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    width: '100%',
    textAlign: 'left',
    // 10/12 rather than 12/14: two rows this size sit as a list, which is what
    // a choice between two things should look like.
    padding: '10px 12px',
    borderRadius: 'var(--tp-radius-sm, 8px)',
    border: '1px solid var(--tp-border, #E6DFD4)',
    // Tinted against the white card so a row reads as a target, not a divider.
    background: 'var(--tp-surface-muted, #FBF8F3)',
    fontFamily: 'inherit',
  };

  if (!actionable) {
    // A div, not a disabled button: there is nothing wrong with this account,
    // the price simply isn't purchasable on the web. A greyed-out button would
    // read as "you can't have this".
    return (
      <div data-testid="purchase-sheet-plan" data-product-id={product.id} style={frame}>
        {inner}
      </div>
    );
  }

  return (
    <button
      data-testid="purchase-sheet-plan"
      data-product-id={product.id}
      onClick={onSelect}
      disabled={busy}
      style={{
        ...frame,
        cursor: busy ? 'default' : 'pointer',
        opacity: busy && !pending ? 0.5 : 1,
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
    >
      {inner}
    </button>
  );
}
