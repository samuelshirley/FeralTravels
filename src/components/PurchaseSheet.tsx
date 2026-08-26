'use client';

import { useEffect } from 'react';
import Spinner from '@/components/Spinner';
import { APP_STORE_URL } from '@/lib/paywallCopy';
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
 * It renders prices it was handed. It does not decide who can buy, what a
 * plan costs, or whether the fake-purchase path is available — all three come
 * from `GET /api/me/entitlement`, and the server refuses the purchase again on
 * its own authority regardless of what this sheet chose to show.
 */
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
  // leave the account subscribed and the UI still paywalled until a reload.
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
          boxShadow: '0 8px 40px rgba(0, 0, 0, 0.18)',
          width: '100%',
          maxWidth: 400,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            height: 4,
            background:
              'linear-gradient(90deg, var(--tp-primary, #4E7AB0), var(--tp-accent-warm, #C97B63))',
          }}
        />

        <div style={{ padding: '24px 24px 20px' }}>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 14,
              right: 12,
              width: 28,
              height: 28,
              border: 'none',
              background: 'transparent',
              color: 'var(--tp-subtle, #999)',
              fontSize: 20,
              lineHeight: '28px',
              padding: 0,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            ×
          </button>

          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--tp-text, #333)',
              margin: '0 0 4px',
            }}
          >
            Feral Travels
          </h2>
          <p
            style={{
              fontSize: 13,
              color: 'var(--tp-muted, #5C5C5C)',
              margin: '0 0 18px',
            }}
          >
            Choose a plan
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                marginTop: 14,
                padding: '8px 10px',
                background: 'rgba(212, 160, 23, 0.12)',
                border: '1px solid rgba(212, 160, 23, 0.35)',
                borderRadius: 'var(--tp-radius-sm, 8px)',
                fontSize: 11.5,
                lineHeight: 1.5,
                color: 'var(--tp-text, #333)',
              }}
            >
              {/* Loud on purpose. This path grants a real subscription with no
                  payment, and the one place that must be unmistakable is a
                  screenshot of the sheet that granted it. */}
              <strong>Test purchase — no payment.</strong> Your account is
              allowlisted, so picking a plan grants it directly and logs a{' '}
              <code style={{ fontSize: 11 }}>FAKE_PURCHASE</code> event. No money
              moves.
            </div>
          ) : (
            <div
              data-testid="purchase-sheet-iphone-notice"
              style={{
                marginTop: 14,
                fontSize: 12.5,
                lineHeight: 1.6,
                color: 'var(--tp-muted, #5C5C5C)',
              }}
            >
              Subscriptions are bought in the Feral Travels app on iPhone — the
              web app isn&apos;t a purchase surface. Everything you plan there
              shows up here.
              <div style={{ marginTop: 10 }}>
                <a
                  href={APP_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '9px 16px',
                    borderRadius: 'var(--tp-radius-sm, 8px)',
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: 'none',
                    background: 'var(--tp-primary, #4E7AB0)',
                    color: 'var(--tp-on-primary, #fff)',
                  }}
                >
                  Continue on iPhone
                </a>
              </div>
            </div>
          )}

          {error && (
            <div
              data-testid="purchase-sheet-error"
              style={{
                marginTop: 12,
                padding: '8px 10px',
                background: 'var(--tp-danger-muted, rgba(198, 93, 74, 0.12))',
                border: '1px solid rgba(198, 93, 74, 0.35)',
                borderRadius: 'var(--tp-radius-sm, 8px)',
                fontSize: 12,
                lineHeight: 1.5,
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
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--tp-text, #333)' }}>
          {product.priceLabel}
        </span>
        <span style={{ fontSize: 13, color: 'var(--tp-muted, #5C5C5C)' }}>
          {product.cadence}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {product.note && (
          <span
            style={{
              padding: '3px 8px',
              borderRadius: 999,
              background: 'var(--tp-success-muted, rgba(74, 139, 122, 0.14))',
              color: 'var(--tp-success, #4A8B7A)',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {product.note}
          </span>
        )}
        {pending && <Spinner size={13} thickness={2} color="var(--tp-primary)" />}
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
    padding: '12px 14px',
    borderRadius: 'var(--tp-radius-sm, 8px)',
    border: '1px solid var(--tp-border, rgba(127,127,127,0.25))',
    background: 'var(--tp-surface, #fff)',
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
      }}
    >
      {inner}
    </button>
  );
}
