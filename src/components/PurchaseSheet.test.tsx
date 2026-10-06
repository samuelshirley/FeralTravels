/**
 * The purchase sheet opened from Penny's bubble and the pane scrim: a small
 * modal around PurchaseOptions that closes on ×, Escape and an outside click,
 * and NOT on a click inside the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseSheet from './PurchaseSheet';
import { APP_STORE_CTA_LABEL } from '@/lib/paywallCopy';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PurchaseSheet', () => {
  it('is a modal dialog carrying the app link', () => {
    render(<PurchaseSheet onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Get the app' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Feral Travels' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: APP_STORE_CTA_LABEL })).toBeInTheDocument();
    // Opening the sheet costs no request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes on the × button', () => {
    const onClose = vi.fn();
    render(<PurchaseSheet onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<PurchaseSheet onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop, but not on a click inside the card', () => {
    const onClose = vi.fn();
    render(<PurchaseSheet onClose={onClose} />);
    fireEvent.click(screen.getByTestId('purchase-sheet'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('purchase-sheet-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Escape once unmounted', () => {
    const onClose = vi.fn();
    const { unmount } = render(<PurchaseSheet onClose={onClose} />);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers the promo field only when the caller passes onRedeemed', () => {
    const { rerender } = render(<PurchaseSheet onClose={vi.fn()} />);
    expect(screen.queryByRole('textbox', { name: 'Promo code' })).not.toBeInTheDocument();
    rerender(<PurchaseSheet onClose={vi.fn()} onRedeemed={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Promo code' })).toBeInTheDocument();
  });

  it('a redeemed code reaches the caller through onRedeemed without closing the sheet itself', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/api/promo/redeem' ? json({ ok: true }) : json({ entitled: true })
    );
    const onClose = vi.fn();
    const onRedeemed = vi.fn();
    render(<PurchaseSheet onClose={onClose} onRedeemed={onRedeemed} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Promo code' }), {
      target: { value: 'FERAL-AAAA-BBBB' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});
