/**
 * The "Test error UI" menu on /admin — it fires a deliberate failure at each
 * tier of the global error surface.
 *
 * The component's own catch is empty by design: it goes through `apiFetch`,
 * which hands every failure to the global ErrorNotifier's reporter before
 * throwing. So "not swallowed" here means the registered reporter is called —
 * that is what puts the toast / modal on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { ApiError, registerGlobalErrorReporter } from '@/lib/api';
import AdminTestErrorButton from './AdminTestErrorButton';

function pendingFetch() {
  let release!: (res: Response) => void;
  let fail!: (err: Error) => void;
  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((res, rej) => {
        release = res;
        fail = rej;
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    release: (res: Response) => act(async () => release(res)),
    fail: (err: Error) => act(async () => fail(err)),
  };
}

const reporter = vi.fn();

describe('AdminTestErrorButton', () => {
  beforeEach(() => {
    reporter.mockReset();
    registerGlobalErrorReporter(reporter);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    registerGlobalErrorReporter(null);
    vi.unstubAllGlobals();
  });

  it('is one button; the menu opens on tap and closes on a second tap', () => {
    render(<AdminTestErrorButton />);
    expect(screen.getByRole('button', { name: 'Test error UI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Throw 400 (toast)' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Test error UI' }));
    expect(screen.getByRole('button', { name: 'Throw 400 (toast)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Throw 500 (silly modal)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network fail (silly modal)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Test error UI' }));
    expect(screen.queryByRole('button', { name: 'Throw 400 (toast)' })).toBeNull();
  });

  it.each([
    ['Throw 400 (toast)', '4xx', 400],
    ['Throw 500 (silly modal)', '5xx', 500],
  ] as const)('"%s" GETs the %s test route and hands the failure to the global notifier', async (label, kind, status) => {
    const { fetchMock, release } = pendingFetch();
    render(<AdminTestErrorButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Test error UI' }));
    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/test-error?kind=${kind}`);
    expect(init.method).toBe('GET');

    // In flight: says so, and cannot be pressed.
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();

    await release(new Response(JSON.stringify({ error: `Injected ${status}` }), { status }));

    await waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    const [err, ctx] = reporter.mock.calls[0] as [unknown, { path: string; status: number | null }];
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(`Injected ${status}`);
    expect(ctx).toMatchObject({ path: `/api/admin/test-error?kind=${kind}`, status });

    // Settles back: button re-enabled, menu closed.
    expect(screen.getByRole('button', { name: 'Test error UI' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  it('"Network fail" reports a rejected fetch to the notifier with no status', async () => {
    const { fetchMock, fail } = pendingFetch();
    render(<AdminTestErrorButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Test error UI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Network fail (silly modal)' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://trip-planner-does-not-exist.invalid/nope');

    const netErr = new TypeError('Failed to fetch');
    await fail(netErr);

    await waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));
    expect(reporter).toHaveBeenCalledWith(netErr, {
      path: 'https://trip-planner-does-not-exist.invalid/nope',
      status: null,
    });
    expect(screen.getByRole('button', { name: 'Test error UI' })).toBeEnabled();
  });
});
