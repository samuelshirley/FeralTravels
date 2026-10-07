/**
 * Minting a promo code for one address, from /admin.
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. Pins the
 * list load on mount (and its failure said, not shown as "no codes ever"), the
 * mint button refusing until an address AND a term are chosen, the exact POST
 * body, the in-flight state, the minted code shown big with a Copy button, and
 * a failed mint said inline with the form left as typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

import PromoCodeBlock from './PromoCodeBlock';

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

function row(over: Partial<PromoRow>): PromoRow {
  return {
    id: 'p1',
    code: 'ABCD2345',
    display: 'ABCD-2345',
    email: 'friend@example.com',
    note: null,
    createdBy: 'admin@example.com',
    expiresAt: null,
    redeemedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    redeemedByEmail: null,
    grantMonths: 6,
    ...over,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/** Routes GET (the list) and POST (mint) to separate handlers. */
function routedFetch(handlers: { list: Handler; mint?: Handler }) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (!handlers.mint) return Promise.reject(new Error('unexpected POST'));
      return handlers.mint(url, init);
    }
    return handlers.list(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const mintButton = () => screen.getByTestId('promo-admin-mint');
const emailInput = () => screen.getByTestId('promo-admin-email');
const monthsSelect = () => screen.getByTestId('promo-admin-months');
const expiresInput = () => screen.getByTestId('promo-admin-expires');
const noteInput = () => screen.getByPlaceholderText('note (who, why)');

async function renderBlock(paywallOn = true) {
  render(<PromoCodeBlock paywallOn={paywallOn} />);
  // Let the mount-time list load settle.
  await act(async () => {});
}

describe('PromoCodeBlock — list', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads the codes on mount, uncached, and shows each with its status', async () => {
    const past = '2020-01-01T00:00:00.000Z';
    const future = '2099-06-01T00:00:00.000Z';
    const redeemed = '2026-09-15T00:00:00.000Z';
    const fetchMock = routedFetch({
      list: async () =>
        json({
          codes: [
            row({ id: 'a', display: 'AAAA-1111', note: 'podcast guest' }),
            row({ id: 'b', display: 'BBBB-2222', expiresAt: future, grantMonths: 12 }),
            row({ id: 'c', display: 'CCCC-3333', expiresAt: past }),
            row({ id: 'd', display: 'DDDD-4444', redeemedAt: redeemed, redeemedByEmail: 'friend@example.com' }),
            row({ id: 'e', display: 'EEEE-5555', redeemedAt: redeemed, redeemedByEmail: null }),
          ],
        }),
    });
    await renderBlock();

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/promo', { cache: 'no-store' });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);

    const ends = new Date(redeemed);
    ends.setMonth(ends.getMonth() + 6);
    const redeemedOn = new Date(redeemed).toLocaleDateString();

    expect(within(rows[0]).getByText('AAAA-1111')).toBeInTheDocument();
    expect(within(rows[0]).getByText('podcast guest')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Unused · 6mo')).toBeInTheDocument();
    expect(
      within(rows[1]).getByText(`Unused · 12mo · code expires ${new Date(future).toLocaleDateString()}`),
    ).toBeInTheDocument();
    expect(within(rows[2]).getByText('Expired, unused · 6mo')).toBeInTheDocument();
    expect(
      within(rows[3]).getByText(
        `Redeemed ${redeemedOn} by friend@example.com · access ends ${ends.toLocaleDateString()}`,
      ),
    ).toBeInTheDocument();
    expect(within(rows[4]).getByText(/\(account since deleted\)/)).toBeInTheDocument();
  });

  it('no codes: no table', async () => {
    routedFetch({ list: async () => json({ codes: [] }) });
    await renderBlock();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a non-2xx list load is said, not rendered as an empty list', async () => {
    routedFetch({ list: async () => json({ error: 'nope' }, 500) });
    await renderBlock();
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load codes (500)');
  });

  it('a rejected list load is said', async () => {
    routedFetch({ list: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderBlock();
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
  });

  it('warns when the paywall is off, and only then', async () => {
    routedFetch({ list: async () => json({ codes: [] }) });
    await renderBlock(false);
    expect(screen.getByText('The paywall is switched off here.')).toBeInTheDocument();
    cleanup();
    await renderBlock(true);
    expect(screen.queryByText('The paywall is switched off here.')).toBeNull();
  });
});

describe('PromoCodeBlock — mint', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('refuses to mint until an address and a term are both chosen', async () => {
    routedFetch({ list: async () => json({ codes: [] }) });
    await renderBlock();

    expect(mintButton()).toBeDisabled();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    expect(mintButton()).toBeDisabled();
    fireEvent.change(monthsSelect(), { target: { value: '12' } });
    expect(mintButton()).toBeEnabled();
    fireEvent.change(emailInput(), { target: { value: '   ' } });
    expect(mintButton()).toBeDisabled();
  });

  it('the expiry field keeps digits only', async () => {
    routedFetch({ list: async () => json({ codes: [] }) });
    await renderBlock();
    fireEvent.change(expiresInput(), { target: { value: '3a0d' } });
    expect(expiresInput()).toHaveValue('30');
  });

  it('posts the form, disables it in flight, then shows the code, clears the form and reloads the list', async () => {
    const minted = row({ id: 'new', display: 'NEWC-0DE1', email: 'friend@example.com', grantMonths: 12 });
    let releaseMint!: (r: Response) => void;
    let listed: PromoRow[] = [];
    const fetchMock = routedFetch({
      list: async () => json({ codes: listed }),
      mint: () => new Promise<Response>((r) => (releaseMint = r)),
    });
    await renderBlock();

    fireEvent.change(emailInput(), { target: { value: '  friend@example.com ' } });
    fireEvent.change(noteInput(), { target: { value: ' met at Moab ' } });
    fireEvent.change(expiresInput(), { target: { value: '30' } });
    fireEvent.change(monthsSelect(), { target: { value: '12' } });
    fireEvent.click(mintButton());
    fireEvent.click(mintButton());

    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/promo');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'create',
      email: 'friend@example.com',
      note: 'met at Moab',
      expiresInDays: 30,
      grantMonths: 12,
    });

    expect(mintButton()).toHaveTextContent('Minting…');
    expect(mintButton()).toBeDisabled();
    expect(emailInput()).toBeDisabled();

    listed = [minted];
    await act(async () => releaseMint(json({ code: minted })));

    const card = await screen.findByTestId('promo-admin-minted');
    expect(within(card).getByText('NEWC-0DE1')).toBeInTheDocument();
    expect(card.textContent).toContain('For friend@example.com · 12 months of access · code never expires');
    expect(emailInput()).toHaveValue('');
    expect(noteInput()).toHaveValue('');
    expect(expiresInput()).toHaveValue('');
    expect(monthsSelect()).toHaveValue('');
    expect(mintButton()).toHaveTextContent('Mint code');

    // The list was read again after the mint.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, i]) => i?.method !== 'POST')).toHaveLength(2),
    );
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('leaves out the optional fields when they are blank', async () => {
    const fetchMock = routedFetch({
      list: async () => json({ codes: [] }),
      mint: async () => json({ code: row({}) }),
    });
    await renderBlock();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    fireEvent.change(monthsSelect(), { target: { value: '6' } });
    fireEvent.click(mintButton());
    await screen.findByTestId('promo-admin-minted');

    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST') as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'create',
      email: 'friend@example.com',
      grantMonths: 6,
    });
  });

  it('Copy puts the display code on the clipboard and says Copied', async () => {
    routedFetch({
      list: async () => json({ codes: [] }),
      mint: async () => json({ code: row({ display: 'COPY-ME12' }) }),
    });
    await renderBlock();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    fireEvent.change(monthsSelect(), { target: { value: '6' } });
    fireEvent.click(mintButton());
    const card = await screen.findByTestId('promo-admin-minted');

    fireEvent.click(within(card).getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('COPY-ME12');
    expect(await within(card).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('a non-2xx mint shows the server error and keeps what was typed', async () => {
    routedFetch({
      list: async () => json({ codes: [] }),
      mint: async () => json({ error: 'That address already has an unused code' }, 409),
    });
    await renderBlock();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    fireEvent.change(monthsSelect(), { target: { value: '6' } });
    fireEvent.click(mintButton());

    expect((await screen.findByRole('alert')).textContent).toBe('That address already has an unused code');
    expect(screen.queryByTestId('promo-admin-minted')).toBeNull();
    expect(emailInput()).toHaveValue('friend@example.com');
    expect(mintButton()).toBeEnabled();
  });

  it('a non-JSON mint error names the status', async () => {
    routedFetch({
      list: async () => json({ codes: [] }),
      mint: async () => new Response('<html/>', { status: 502 }),
    });
    await renderBlock();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    fireEvent.change(monthsSelect(), { target: { value: '6' } });
    fireEvent.click(mintButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Could not mint a code (502)');
  });

  it('a rejected mint is said, not swallowed', async () => {
    routedFetch({
      list: async () => json({ codes: [] }),
      mint: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await renderBlock();
    fireEvent.change(emailInput(), { target: { value: 'friend@example.com' } });
    fireEvent.change(monthsSelect(), { target: { value: '6' } });
    fireEvent.click(mintButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
    expect(mintButton()).toBeEnabled();
  });
});
