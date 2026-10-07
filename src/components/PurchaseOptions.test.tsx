/**
 * What the web offers an account it will not let plan: the App Store link,
 * and (when the caller passes `onRedeemed`) a promo code field. The redeem
 * path asks the server twice — POST the code, then re-read entitlement — and
 * only calls `onRedeemed` once the SERVER says the account is entitled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PurchaseOptions from './PurchaseOptions';
import { APP_STORE_CTA_LABEL, APP_STORE_URL } from '@/lib/paywallCopy';
import { PROMO_CTA_LABEL, PROMO_PLACEHOLDER } from '@/lib/promoCopy';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let redeemResponse: () => Promise<Response>;
let entitlementResponse: () => Promise<Response>;

beforeEach(() => {
  redeemResponse = async () => json({ ok: true });
  entitlementResponse = async () => json({ entitled: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/promo/redeem') return redeemResponse();
    if (url === '/api/me/entitlement') return entitlementResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function codeInput() {
  return screen.getByRole('textbox', { name: 'Promo code' });
}
function redeemButton() {
  return screen.getByRole('button', { name: PROMO_CTA_LABEL });
}

describe('PurchaseOptions — the App Store link', () => {
  it('links out to the App Store in a new tab, with the label saying so', () => {
    render(<PurchaseOptions />);
    const link = screen.getByRole('link', { name: APP_STORE_CTA_LABEL });
    expect(link).toHaveAttribute('href', APP_STORE_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows no prices — a plan is bought in the iPhone app', () => {
    const { container } = render(<PurchaseOptions onRedeemed={vi.fn()} />);
    expect(container.textContent).not.toMatch(/[$€£]\s?\d/);
  });

  it('offers no promo field when the caller has no promo path', () => {
    render(<PurchaseOptions />);
    expect(screen.queryByRole('textbox', { name: 'Promo code' })).not.toBeInTheDocument();
  });
});

describe('PurchaseOptions — redeeming a code', () => {
  it('Redeem is disabled until a code is typed', () => {
    render(<PurchaseOptions onRedeemed={vi.fn()} />);
    expect(codeInput()).toHaveAttribute('placeholder', PROMO_PLACEHOLDER);
    expect(redeemButton()).toBeDisabled();
    fireEvent.change(codeInput(), { target: { value: '   ' } });
    expect(redeemButton()).toBeDisabled();
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    expect(redeemButton()).toBeEnabled();
  });

  it('POSTs the code, re-reads entitlement, and calls onRedeemed only once entitled', async () => {
    const onRedeemed = vi.fn();
    render(<PurchaseOptions onRedeemed={onRedeemed} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1));
    const [redeemUrl, redeemInit] = fetchMock.mock.calls[0];
    expect(redeemUrl).toBe('/api/promo/redeem');
    expect(redeemInit?.method).toBe('POST');
    expect(JSON.parse(String(redeemInit?.body))).toEqual({ code: 'FERAL-AAAA-BBBB' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/me/entitlement');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Enter in the field submits too', async () => {
    const onRedeemed = vi.fn();
    render(<PurchaseOptions onRedeemed={onRedeemed} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-CCCC-DDDD' } });
    fireEvent.keyDown(codeInput(), { key: 'Enter' });
    await waitFor(() => expect(onRedeemed).toHaveBeenCalled());
  });

  it('shows "Checking…" and locks the field while the request is in flight', async () => {
    redeemResponse = () => new Promise<Response>(() => {});
    render(<PurchaseOptions onRedeemed={vi.fn()} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(codeInput()).toBeDisabled();
  });

  it("a 200 that has not switched the plan on yet says so, and does not unblock", async () => {
    entitlementResponse = async () => json({ entitled: false });
    const onRedeemed = vi.fn();
    render(<PurchaseOptions onRedeemed={onRedeemed} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That worked, but your plan hasn't switched on yet. Give it a moment and reload."
    );
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it('an entitlement re-read that fails is not treated as success', async () => {
    entitlementResponse = async () => json({ error: 'down' }, 503);
    const onRedeemed = vi.fn();
    render(<PurchaseOptions onRedeemed={onRedeemed} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/hasn't switched on yet/);
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it("a refusal shows the server's copy verbatim", async () => {
    redeemResponse = async () => json({ error: 'That code has already been used.' }, 409);
    const onRedeemed = vi.fn();
    render(<PurchaseOptions onRedeemed={onRedeemed} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-USED-CODE' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('That code has already been used.');
    expect(onRedeemed).not.toHaveBeenCalled();
    // Only the redeem call; entitlement is not re-read after a refusal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redeemButton()).toBeEnabled();
  });

  it('a non-JSON failure still names the status', async () => {
    redeemResponse = async () => new Response('Bad Gateway', { status: 502 });
    render(<PurchaseOptions onRedeemed={vi.fn()} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not redeem that code (502)');
  });

  it('a rejected fetch (offline) is shown', async () => {
    redeemResponse = async () => {
      throw new TypeError('Failed to fetch');
    };
    render(<PurchaseOptions onRedeemed={vi.fn()} />);
    fireEvent.change(codeInput(), { target: { value: 'FERAL-AAAA-BBBB' } });
    fireEvent.click(redeemButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });
});
