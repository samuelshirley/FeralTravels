/**
 * The disposable-paywalled-account generator on /admin.
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. Pins the
 * unarmed state (no request at all), the paywall-off warning, the create POST
 * per preset, the code + sign-in link shown after, "New code" and "Delete" on
 * an existing account, and failures said inline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

import TestUserBlock from './TestUserBlock';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Handler = (body: Record<string, unknown>) => Promise<Response>;

/** GET is the account list; POST is routed by its `action`. */
function routedFetch(handlers: {
  list: () => Promise<Response>;
  create?: Handler;
  resend?: Handler;
  delete?: Handler;
}) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return handlers.list();
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const h = handlers[body.action as 'create' | 'resend' | 'delete'];
    if (!h) return Promise.reject(new Error(`unexpected POST ${String(body.action)}`));
    return h(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock: ReturnType<typeof routedFetch>) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ url, body: JSON.parse((init as RequestInit).body as string) as unknown }));
const gets = (fetchMock: ReturnType<typeof routedFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST');

const ACCOUNTS = [
  { email: 'sub-test-1@fixtures.example.com', createdAt: '2026-10-01T00:00:00.000Z' },
  { email: 'sub-test-2@fixtures.example.com', createdAt: '2026-10-02T00:00:00.000Z' },
];
const verifyLink = (email: string) => `${window.location.origin}/login/verify?email=${encodeURIComponent(email)}`;

async function renderBlock(props: { armed?: boolean; paywallOn?: boolean } = {}) {
  render(<TestUserBlock armed={props.armed ?? true} paywallOn={props.paywallOn ?? true} />);
  await act(async () => {});
}

const generateButton = () => screen.getByRole('button', { name: /Generate test user|Generating…/ });
/** The row in the EXISTING list (the email can also appear in the result card). */
const accountRow = (email: string): HTMLElement => {
  const row = screen
    .getAllByText(email)
    .map((el) => el.parentElement as HTMLElement)
    .find((p) => within(p).queryByRole('button', { name: 'Delete' }));
  if (!row) throw new Error(`no listed row for ${email}`);
  return row;
};

describe('TestUserBlock', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('unarmed: says how to arm it, and makes no request', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('unexpected fetch')));
    vi.stubGlobal('fetch', fetchMock);
    await renderBlock({ armed: false });
    expect(screen.getByText('SUBSCRIPTION_TESTING=1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate test user' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('armed: lists the existing test accounts', async () => {
    const fetchMock = routedFetch({ list: async () => json({ accounts: ACCOUNTS }) });
    await renderBlock();
    expect(gets(fetchMock)[0][0]).toBe('/api/admin/test-users');
    expect(await screen.findByText('EXISTING (2)')).toBeInTheDocument();
    expect(screen.getByText(ACCOUNTS[0].email)).toBeInTheDocument();
    expect(screen.getByText(ACCOUNTS[1].email)).toBeInTheDocument();
  });

  it('warns first when the paywall is off, and only then', async () => {
    routedFetch({ list: async () => json({ accounts: [] }) });
    await renderBlock({ paywallOn: false });
    expect(screen.getByTestId('test-users-paywall-off')).toBeInTheDocument();
    cleanup();
    await renderBlock({ paywallOn: true });
    expect(screen.queryByTestId('test-users-paywall-off')).toBeNull();
  });

  it('the hint follows the chosen preset', async () => {
    routedFetch({ list: async () => json({ accounts: [] }) });
    await renderBlock();
    expect(screen.getByText(/twelve-day itinerary behind the wall/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Test account type' }), {
      target: { value: 'day7-empty' },
    });
    expect(screen.getByText(/lands straight on Penny/)).toBeInTheDocument();
  });

  it.each([
    ['day7-trip', true],
    ['day7-empty', false],
  ] as const)('preset %s posts a day-7 account with withTrip=%s, disabled in flight', async (preset, withTrip) => {
    let releaseCreate!: (r: Response) => void;
    const fetchMock = routedFetch({
      list: async () => json({ accounts: [] }),
      create: () => new Promise<Response>((r) => (releaseCreate = r)),
    });
    await renderBlock();
    fireEvent.change(screen.getByRole('combobox', { name: 'Test account type' }), { target: { value: preset } });
    fireEvent.click(generateButton());

    expect(posts(fetchMock)).toEqual([
      {
        url: '/api/admin/test-users',
        body: { action: 'create', ageDays: 7, subscription: null, withTrip },
      },
    ]);
    expect(generateButton()).toHaveTextContent('Generating…');
    expect(generateButton()).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Test account type' })).toBeDisabled();

    await act(async () =>
      releaseCreate(json({ account: { email: 'new@fixtures.example.com' }, code: '482913' })),
    );
    expect(generateButton()).toBeEnabled();
  });

  it('after creating, shows the email, the code and the sign-in link, and re-reads the list', async () => {
    const email = 'new+1@fixtures.example.com';
    const fetchMock = routedFetch({
      list: async () => json({ accounts: [] }),
      create: async () => json({ account: { email }, code: '482913' }),
    });
    await renderBlock();
    fireEvent.click(generateButton());

    expect(await screen.findByText('482913')).toBeInTheDocument();
    expect(screen.getByText(email)).toBeInTheDocument();
    expect(screen.getByText(verifyLink(email))).toBeInTheDocument();
    await waitFor(() => expect(gets(fetchMock)).toHaveLength(2));

    fireEvent.click(within(screen.getByText('482913').parentElement as HTMLElement).getByRole('button', { name: 'Copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('482913');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('a create whose code failed to send says so and offers no Copy for it', async () => {
    routedFetch({
      list: async () => json({ accounts: [] }),
      create: async () => json({ account: { email: 'x@fixtures.example.com' }, code: null }),
    });
    await renderBlock();
    fireEvent.click(generateButton());
    const codeValue = await screen.findByText('send failed — use “New code”');
    expect(within(codeValue.parentElement as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('a non-2xx create shows the server error', async () => {
    routedFetch({
      list: async () => json({ accounts: [] }),
      create: async () => json({ error: 'Testing is off in production' }, 403),
    });
    await renderBlock();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Testing is off in production');
    expect(generateButton()).toBeEnabled();
  });

  it('a non-2xx create with no message falls back to a sentence', async () => {
    routedFetch({
      list: async () => json({ accounts: [] }),
      create: async () => json({}, 500),
    });
    await renderBlock();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Could not create the account');
  });

  it('a non-JSON create error still shows an error', async () => {
    routedFetch({
      list: async () => json({ accounts: [] }),
      create: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });
    await renderBlock();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).not.toBe('');
    expect(generateButton()).toBeEnabled();
  });

  it('a rejected create is said, not swallowed', async () => {
    routedFetch({
      list: async () => json({ accounts: [] }),
      create: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await renderBlock();
    fireEvent.click(generateButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
  });

  it('"New code" posts a resend and shows the fresh code with its link', async () => {
    const email = ACCOUNTS[0].email;
    const fetchMock = routedFetch({
      list: async () => json({ accounts: ACCOUNTS }),
      resend: async () => json({ code: '111222' }),
    });
    await renderBlock();
    fireEvent.click(within(accountRow(email)).getByRole('button', { name: 'New code' }));

    expect(await screen.findByText('111222')).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([{ url: '/api/admin/test-users', body: { action: 'resend', email } }]);
    expect(screen.getByText(verifyLink(email))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a throttled resend (429) still shows the pending code, without an error', async () => {
    routedFetch({
      list: async () => json({ accounts: ACCOUNTS }),
      resend: async () => json({ code: '333444', error: 'Too soon' }, 429),
    });
    await renderBlock();
    fireEvent.click(within(accountRow(ACCOUNTS[0].email)).getByRole('button', { name: 'New code' }));
    expect(await screen.findByText('333444')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed resend with no code says so', async () => {
    routedFetch({
      list: async () => json({ accounts: ACCOUNTS }),
      resend: async () => json({ error: 'Resend is down' }, 502),
    });
    await renderBlock();
    fireEvent.click(within(accountRow(ACCOUNTS[0].email)).getByRole('button', { name: 'New code' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Resend is down');
    expect(screen.getByText('send failed — use “New code”')).toBeInTheDocument();
  });

  // No confirmation step exists on Delete: these are disposable fixture
  // accounts, and one tap removes one. Pinned as-is.
  it('"Delete" posts a delete for that account, clears it from the result card, and re-reads the list', async () => {
    const email = ACCOUNTS[0].email;
    let listed = ACCOUNTS;
    const fetchMock = routedFetch({
      list: async () => json({ accounts: listed }),
      resend: async () => json({ code: '555666' }),
      delete: async () => {
        listed = ACCOUNTS.slice(1);
        return json({ ok: true });
      },
    });
    await renderBlock();
    // Put this account in the result card first, so the delete has to clear it.
    fireEvent.click(within(accountRow(email)).getByRole('button', { name: 'New code' }));
    expect(await screen.findByText('555666')).toBeInTheDocument();

    fireEvent.click(within(accountRow(email)).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('555666')).toBeNull());
    expect(posts(fetchMock)).toContainEqual({ url: '/api/admin/test-users', body: { action: 'delete', email } });
    expect(await screen.findByText('EXISTING (1)')).toBeInTheDocument();
    expect(screen.queryByText(email)).toBeNull();
    expect(screen.getByText(ACCOUNTS[1].email)).toBeInTheDocument();
  });

  it('a failed delete shows the server error and keeps the account listed', async () => {
    routedFetch({
      list: async () => json({ accounts: ACCOUNTS }),
      delete: async () => json({ error: 'Not a fixture address' }, 400),
    });
    await renderBlock();
    fireEvent.click(within(accountRow(ACCOUNTS[0].email)).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not a fixture address');
    expect(screen.getByText(ACCOUNTS[0].email)).toBeInTheDocument();
  });

  it('a rejected delete is said, not swallowed', async () => {
    routedFetch({
      list: async () => json({ accounts: ACCOUNTS }),
      delete: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await renderBlock();
    fireEvent.click(within(accountRow(ACCOUNTS[0].email)).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
  });

  // BUG (convention: "Never silently swallow errors" / "No empty catch blocks"):
  // TestUserBlock.tsx `refresh()` returns early on a non-2xx list read and has a
  // comment-only catch, so a failed list load renders exactly like "no test
  // accounts exist" — and after a successful Delete, a failed re-read leaves the
  // deleted account on screen with nothing said. The source comment calls this
  // deliberate ("not worth an error banner"); PromoCodeBlock decided the
  // opposite for the same situation. Flip to `it` once the list failure is shown.
  it.fails('a failed list load is said, not rendered as "no accounts"', async () => {
    routedFetch({ list: async () => json({ error: 'db down' }, 503) });
    await renderBlock();
    expect(await screen.findByRole('alert', {}, { timeout: 200 })).toBeInTheDocument();
  });

  it.fails('a rejected list load is said, not swallowed', async () => {
    routedFetch({ list: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderBlock();
    expect(await screen.findByRole('alert', {}, { timeout: 200 })).toBeInTheDocument();
  });
});
