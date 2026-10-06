/**
 * The one-tap "close the app to Penny" control in the lockdown block.
 *
 * A component test for the same reason as `PaywallSwitch.test.tsx`: /admin is
 * behind a one-person allowlist and no fixture can sign in as an admin.
 *
 * Pins the asymmetry the component documents: turning the lock ON needs a
 * second tap, turning it OFF needs none; and a failure is said inline rather
 * than leaving the admin believing the app is closed when it is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import PennyLockSwitch from './PennyLockSwitch';

/** A fetch whose response the test releases by hand, so the in-flight state can be looked at. */
function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => (release = r)));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

function rejectingFetch(message: string) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    throw new TypeError(message);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>, i = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init };
}

describe('PennyLockSwitch', () => {
  beforeEach(() => {
    refresh.mockReset();
    // No test may reach the network; the default fetch fails loudly.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers to close when open, and to reopen when closed', () => {
    render(<PennyLockSwitch locked={false} />);
    expect(screen.getByRole('button', { name: 'Close the app to Penny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Penny back up' })).toBeNull();
    cleanup();
    render(<PennyLockSwitch locked />);
    expect(screen.getByRole('button', { name: 'Open Penny back up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close the app to Penny' })).toBeNull();
  });

  it('closing asks for a second tap first, and Cancel backs out without a request', () => {
    const { fetchMock } = pendingFetch();
    render(<PennyLockSwitch locked={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close the app to Penny' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes — stop Penny for everyone' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close the app to Penny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes — stop Penny for everyone' })).toBeNull();
  });

  it('the confirm tap posts locked:true, says Closing… while in flight, then refreshes', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<PennyLockSwitch locked={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close the app to Penny' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes — stop Penny for everyone' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = sent(fetchMock);
    expect(url).toBe('/api/admin/penny-lock');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ locked: true });

    const inFlight = screen.getByRole('button', { name: 'Closing…' });
    expect(inFlight).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('reopening is one tap: posts locked:false, says Opening… while in flight', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<PennyLockSwitch locked />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Penny back up' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = sent(fetchMock);
    expect(url).toBe('/api/admin/penny-lock');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ locked: false });
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Open Penny back up' })).toBeEnabled();
  });

  it('a non-2xx says it did not stick, with the server message, and does not refresh', async () => {
    const { release } = pendingFetch();
    render(<PennyLockSwitch locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close the app to Penny' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes — stop Penny for everyone' }));

    await release(new Response(JSON.stringify({ error: 'Injected failure' }), { status: 500 }));

    expect(await screen.findByText('Didn’t stick: Injected failure')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    // Still armed, and pressable again.
    expect(screen.getByRole('button', { name: 'Yes — stop Penny for everyone' })).toBeEnabled();
  });

  it('a non-JSON error names the status', async () => {
    const { release } = pendingFetch();
    render(<PennyLockSwitch locked />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Penny back up' }));

    await release(new Response('<html>bad gateway</html>', { status: 502 }));

    expect(await screen.findByText('Didn’t stick: HTTP 502')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a rejected fetch is said, not swallowed', async () => {
    rejectingFetch('Failed to fetch');
    render(<PennyLockSwitch locked />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Penny back up' }));

    expect(await screen.findByText('Didn’t stick: Failed to fetch')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open Penny back up' })).toBeEnabled();
  });
});
