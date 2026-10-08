/**
 * Break-glass revoke / re-activate on /admin/users/[id].
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. Pins the
 * obstruction — a dialog and a typed reason before either request — the
 * paid-through warning on revoke, the landing line on re-activate, the blocked
 * undo, disabled-while-in-flight, and failures said inside the dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import RevokeAccessControl from './RevokeAccessControl';

function pendingFetch() {
  let release!: (res: Response) => void;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => (release = r)));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, release: (res: Response) => act(async () => release(res)) };
}

const revokeProps = {
  userId: 'u_7',
  userLabel: 'payer@example.com',
  paidThrough: '2027-03-14',
  alreadyRevoked: false,
  reactivateLanding: null,
  reactivateBlockedMessage: null,
};
const reactivateProps = {
  ...revokeProps,
  paidThrough: null,
  alreadyRevoked: true,
  reactivateLanding: 'Back to active, renewing 2027-03-14.',
};

const dialog = () => screen.getByRole('dialog');
const reasonInput = () => within(dialog()).getByLabelText('Reason (recorded with your email and the time)');

describe('RevokeAccessControl — revoke', () => {
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

  it('opens a dialog rather than revoking, and warns about paid-for time', () => {
    const { fetchMock } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialog()).toHaveAccessibleName('Revoke access');
    expect(within(dialog()).getByRole('heading', { name: 'Revoke access for payer@example.com?' })).toBeInTheDocument();
    expect(
      within(dialog()).getByText(
        'This user has paid through 2027-03-14. Revoking takes away time they already paid for.',
      ),
    ).toBeInTheDocument();
  });

  it('omits the paid-through warning when nothing is left on the clock', () => {
    render(<RevokeAccessControl {...revokeProps} paidThrough={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(within(dialog()).queryByText(/has paid through/)).toBeNull();
  });

  it('the confirm button stays disabled until a non-blank reason is typed', () => {
    const { fetchMock } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

    const confirm = within(dialog()).getByRole('button', { name: 'Revoke access' });
    expect(confirm).toBeDisabled();
    fireEvent.change(reasonInput(), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(reasonInput(), { target: { value: 'refund confirmed' } });
    expect(confirm).toBeEnabled();
  });

  it('posts the trimmed reason to the revoke route once, disabled in flight, then closes and refreshes', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.change(reasonInput(), { target: { value: '  REFUND never arrived  ' } });

    const confirm = within(dialog()).getByRole('button', { name: 'Revoke access' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/subscription/revoke');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u_7', reason: 'REFUND never arrived' });

    expect(within(dialog()).getByRole('button', { name: 'Revoking…' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(reasonInput()).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel and Escape close the dialog without a request, and clear the reason', () => {
    const { fetchMock } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.change(reasonInput(), { target: { value: 'abuse' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(reasonInput()).toHaveValue('');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-2xx shows the server error in the dialog and keeps it open', async () => {
    const { release } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.change(reasonInput(), { target: { value: 'abuse' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke access' }));

    await release(new Response(JSON.stringify({ error: 'No subscription row' }), { status: 404 }));

    expect((await within(dialog()).findByRole('alert')).textContent).toBe('No subscription row');
    expect(reasonInput()).toHaveValue('abuse');
    expect(within(dialog()).getByRole('button', { name: 'Revoke access' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a non-JSON error names the action and the status', async () => {
    const { release } = pendingFetch();
    render(<RevokeAccessControl {...revokeProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.change(reasonInput(), { target: { value: 'abuse' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke access' }));
    await release(new Response('<html/>', { status: 500 }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Revoke failed (500)');
  });

  it('a rejected fetch is shown in the dialog, not swallowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<RevokeAccessControl {...revokeProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.change(reasonInput(), { target: { value: 'abuse' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke access' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Failed to fetch');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('RevokeAccessControl — re-activate', () => {
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

  it('points the other way and says what the account lands back on', () => {
    render(<RevokeAccessControl {...reactivateProps} />);
    expect(screen.queryByRole('button', { name: 'Revoke access' })).toBeNull();
    expect(screen.getByText('Back to active, renewing 2027-03-14.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Re-activate access' }));
    expect(dialog()).toHaveAccessibleName('Re-activate access');
    expect(within(dialog()).getByRole('heading', { name: 'Re-activate access for payer@example.com?' })).toBeInTheDocument();
    expect(within(dialog()).getByText('Back to active, renewing 2027-03-14.')).toBeInTheDocument();
    expect(within(dialog()).queryByText(/has paid through/)).toBeNull();
  });

  it('a blocked undo is disabled and says why', () => {
    render(
      <RevokeAccessControl
        {...reactivateProps}
        reactivateLanding={null}
        reactivateBlockedMessage="Revoked before the prior status was recorded."
      />,
    );
    expect(screen.getByRole('button', { name: 'Re-activate access' })).toBeDisabled();
    expect(screen.getByText('Revoked before the prior status was recorded.')).toBeInTheDocument();
  });

  it('posts the reason to the reactivate route, then closes and refreshes', async () => {
    const { fetchMock, release } = pendingFetch();
    render(<RevokeAccessControl {...reactivateProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-activate access' }));
    const confirm = within(dialog()).getByRole('button', { name: 'Re-activate access' });
    expect(confirm).toBeDisabled();
    fireEvent.change(reasonInput(), { target: { value: 'revoked by mistake' } });
    fireEvent.click(confirm);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/subscription/reactivate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u_7', reason: 'revoked by mistake' });
    expect(within(dialog()).getByRole('button', { name: 'Re-activating…' })).toBeDisabled();

    await release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a non-JSON error names the re-activation and the status', async () => {
    const { release } = pendingFetch();
    render(<RevokeAccessControl {...reactivateProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-activate access' }));
    fireEvent.change(reasonInput(), { target: { value: 'mistake' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Re-activate access' }));
    await release(new Response('', { status: 409 }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Re-activation failed (409)');
    expect(refresh).not.toHaveBeenCalled();
  });
});
