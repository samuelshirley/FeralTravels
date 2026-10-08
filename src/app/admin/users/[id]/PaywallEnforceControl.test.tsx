/**
 * The per-account "Force the paywall on this account" switch.
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. Pins that
 * one tap posts the negation of the current state (no confirm step, by design),
 * the switch is disabled while in flight, a double tap sends one request, it
 * shows ON and locked while the global paywall is on, the comped explanation
 * appears exactly when it is true, and failures are said inline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import PaywallEnforceControl from './PaywallEnforceControl';

function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => (release = r)));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const base = { userId: 'u_9', userLabel: 'test@example.com', comped: false, globalOn: false };
const toggle = () => screen.getByRole('switch', { name: 'Force the paywall on test@example.com' });

describe('PaywallEnforceControl', () => {
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

  it('aria-checked reflects the current override', () => {
    render(<PaywallEnforceControl {...base} enforced />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    cleanup();
    render(<PaywallEnforceControl {...base} enforced={false} />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });

  it.each([true, false])('from enforced=%s, one tap posts the negation once, disabled in flight', async (enforced) => {
    const { fetchMock, release } = pendingFetch();
    render(<PaywallEnforceControl {...base} enforced={enforced} />);

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/paywall/user');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u_9', enforced: !enforced });
    expect(toggle()).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(toggle()).toBeEnabled();
  });

  it('warns that the override is inert on a comped account, only while it is enforced', () => {
    render(<PaywallEnforceControl {...base} comped enforced />);
    expect(screen.getByText('This account is comped')).toBeInTheDocument();
    cleanup();
    render(<PaywallEnforceControl {...base} comped enforced={false} />);
    expect(screen.queryByText('This account is comped')).toBeNull();
    cleanup();
    render(<PaywallEnforceControl {...base} enforced />);
    expect(screen.queryByText('This account is comped')).toBeNull();
  });

  // It once showed OFF on an account the global paywall was walling — it
  // rendered the raw override column — and read as "not under the paywall".
  it('shows ON and is locked while the global switch is on, whatever the override', () => {
    for (const enforced of [false, true]) {
      render(<PaywallEnforceControl {...base} globalOn enforced={enforced} />);
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
      expect(toggle()).toBeDisabled();
      fireEvent.click(toggle());
      expect(screen.getByText('On for every account while the deployment-wide paywall is on.')).toBeInTheDocument();
      cleanup();
    }
  });

  it('says a comped account is exempt while the global switch is on', () => {
    render(<PaywallEnforceControl {...base} comped globalOn enforced={false} />);
    expect(screen.getByText('This account is comped')).toBeInTheDocument();
  });

  it('a non-2xx shows the server error inline and does not refresh', async () => {
    const { release } = pendingFetch();
    render(<PaywallEnforceControl {...base} enforced={false} />);
    fireEvent.click(toggle());
    await release(new Response(JSON.stringify({ error: 'Injected failure' }), { status: 500 }));

    expect((await screen.findByRole('alert')).textContent).toBe('Injected failure');
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(toggle()).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a non-JSON error names the status', async () => {
    const { release } = pendingFetch();
    render(<PaywallEnforceControl {...base} enforced />);
    fireEvent.click(toggle());
    await release(new Response('<html/>', { status: 503 }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not change the override (503)');
  });

  it('a rejected fetch is shown, not swallowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<PaywallEnforceControl {...base} enforced={false} />);
    fireEvent.click(toggle());
    expect((await screen.findByRole('alert')).textContent).toBe('Failed to fetch');
    expect(refresh).not.toHaveBeenCalled();
  });
});
