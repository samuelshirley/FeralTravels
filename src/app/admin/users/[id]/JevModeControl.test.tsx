/**
 * The per-account message-classifier override on /admin/users/[id].
 *
 * Component test, not e2e: /admin is behind a one-person allowlist and no
 * fixture can sign in as an admin. Pins four pills with exactly one checked,
 * one POST per tap carrying the chosen mode (null = follow global), no request
 * for the mode already on, disabled while in flight, and failures said inline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import JevModeControl from './JevModeControl';

function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => (release = r)));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const base = { userId: 'u_123', userLabel: 'ada@example.com', globalMode: 'compare' as const };
const radios = () => screen.getAllByRole('radio');
const checked = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true');

describe('JevModeControl', () => {
  beforeEach(() => {
    refresh.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    [null, 'Follow global (Compare)'],
    ['off', 'Haiku only'],
    ['compare', 'Compare'],
    ['on', 'Jev first'],
  ] as const)('override %s checks exactly "%s"', (override, label) => {
    render(<JevModeControl {...base} override={override} />);
    expect(screen.getByRole('radiogroup', { name: 'Message classifier for ada@example.com' })).toBeInTheDocument();
    expect(radios().map((r) => r.textContent)).toEqual([
      'Follow global (Compare)',
      'Haiku only',
      'Compare',
      'Jev first',
    ]);
    expect(checked().map((r) => r.textContent)).toEqual([label]);
  });

  it('"Follow global" names what the global switch resolves to', () => {
    render(<JevModeControl {...base} globalMode="on" override={null} />);
    expect(screen.getByRole('radio', { name: 'Follow global (Jev)' })).toBeInTheDocument();
  });

  it('a failed read says so instead of offering pills', () => {
    render(<JevModeControl {...base} override={undefined} />);
    expect(screen.getByRole('alert').textContent).toBe("Could not read this account's classifier setting.");
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it.each([
    ['admin-jev-user-on', 'on'],
    ['admin-jev-user-off', 'off'],
    ['admin-jev-user-compare', 'compare'],
  ] as const)('from follow-global, tapping %s posts mode %s once, disabled while in flight', async (testId, mode) => {
    const { fetchMock, release } = pendingFetch();
    render(<JevModeControl {...base} override={null} />);

    fireEvent.click(screen.getByTestId(testId));
    fireEvent.click(screen.getByTestId(testId));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/jev/user');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u_123', mode });
    for (const r of radios()) expect(r).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    for (const r of radios()) expect(r).toBeEnabled();
  });

  it('going back to follow-global posts mode: null', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<JevModeControl {...base} override="on" />);
    fireEvent.click(screen.getByTestId('admin-jev-user-global'));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u_123', mode: null });
    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('tapping the mode already set posts nothing', () => {
    const { fetchMock } = pendingFetch();
    render(<JevModeControl {...base} override="compare" />);
    fireEvent.click(screen.getByTestId('admin-jev-user-compare'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-2xx shows the server error inline and leaves the true state checked', async () => {
    const { release } = pendingFetch();
    render(<JevModeControl {...base} override={null} />);
    fireEvent.click(screen.getByTestId('admin-jev-user-on'));
    await release(new Response(JSON.stringify({ error: 'Injected failure' }), { status: 500 }));

    expect((await screen.findByRole('alert')).textContent).toBe('Injected failure');
    expect(checked().map((r) => r.textContent)).toEqual(['Follow global (Compare)']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a non-JSON error names the status', async () => {
    const { release } = pendingFetch();
    render(<JevModeControl {...base} override={null} />);
    fireEvent.click(screen.getByTestId('admin-jev-user-off'));
    await release(new Response('<html/>', { status: 502 }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not change the classifier (502)');
  });

  it('a rejected fetch is shown, not swallowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<JevModeControl {...base} override={null} />);
    fireEvent.click(screen.getByTestId('admin-jev-user-off'));
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
    expect(refresh).not.toHaveBeenCalled();
    for (const r of radios()) expect(r).toBeEnabled();
  });
});
