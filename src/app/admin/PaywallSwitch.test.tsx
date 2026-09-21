/**
 * The deployment-wide paywall pill in the /admin header.
 *
 * Why a component test and not an e2e spec: `/admin` is behind `isAdminEmail`,
 * which requires an address on a hardcoded allowlist of one real person, and
 * no fixture user can be on it (see `e2e/fixtures/subscription.ts`). A spec
 * would need a test-only way to sign in as an admin, and the E2E auth rule in
 * CLAUDE.md forbids any sign-in that skips the real OTP flow. The route's own
 * half is held by `adminEndpointCallerGuard` (G9); this file holds the control.
 *
 * It pins what was verified by hand in a browser on 2026-09-21: ONE tap flips
 * it with no arming step, the POST carries the negation of the current state,
 * the pill says SWITCHING… and is disabled in flight, a double tap sends one
 * POST, and a failure renders inline without the pill claiming a flip that
 * did not happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import PaywallSwitch from './PaywallSwitch';

/** A fetch whose response the test releases by hand, so the in-flight state can be looked at. */
function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
  global.fetch = fetchMock as never;
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const pill = () => screen.getByTestId('admin-paywall-switch');

describe('PaywallSwitch', () => {
  beforeEach(() => refresh.mockReset());
  afterEach(cleanup);

  it('renders the current state, and aria-checked agrees with it', () => {
    render(<PaywallSwitch on />);
    expect(pill().textContent).toBe('PAYWALL ON');
    expect(pill().getAttribute('aria-checked')).toBe('true');
    cleanup();
    render(<PaywallSwitch on={false} />);
    expect(pill().textContent).toBe('PAYWALL OFF');
    expect(pill().getAttribute('aria-checked')).toBe('false');
  });

  it.each([true, false])('one tap from %s posts the negation, with no confirm step', async (on) => {
    const { fetchMock, release } = pendingFetch();
    render(<PaywallSwitch on={on} />);

    fireEvent.click(pill());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/paywall');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: !on });
    expect(screen.queryByTestId('admin-paywall-switch-confirm')).toBeNull();

    // In flight: says so, and cannot be pressed.
    expect(pill().textContent).toBe('SWITCHING…');
    expect((pill() as HTMLButtonElement).disabled).toBe(true);

    await release(new Response(JSON.stringify({ enabled: !on }), { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect((pill() as HTMLButtonElement).disabled).toBe(false);
  });

  // Held by `disabled={busy}`, not by the `inFlight` ref: React applies the
  // attribute synchronously on a discrete click, so the second click never
  // reaches `flip()`. Mutation-checked — removing the ref alone leaves this
  // green, removing both turns it red. The ref covers callers that bypass the
  // attribute, which jsdom cannot reproduce.
  it('sends one POST for a double tap', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<PaywallSwitch on={false} />);

    fireEvent.click(pill());
    fireEvent.click(pill());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await release(new Response('{}', { status: 200 }));
  });

  it('shows a failure inline and leaves the pill on the true state', async () => {
    const { release } = pendingFetch();
    render(<PaywallSwitch on={false} />);

    fireEvent.click(pill());
    await release(
      new Response(JSON.stringify({ error: 'Injected failure' }), { status: 500 }),
    );

    expect((await screen.findByRole('alert')).textContent).toBe('Injected failure');
    expect(pill().textContent).toBe('PAYWALL OFF');
    expect(pill().getAttribute('aria-checked')).toBe('false');
    expect((pill() as HTMLButtonElement).disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('names the status when the error body is not JSON', async () => {
    const { release } = pendingFetch();
    render(<PaywallSwitch on />);

    fireEvent.click(pill());
    await release(new Response('<html>bad gateway</html>', { status: 502 }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not change the paywall switch (502)',
    );
    expect(pill().textContent).toBe('PAYWALL ON');
  });
});
