/**
 * The new-signups list: joined, last active, trips, and the paywall verdict —
 * including a verdict that could not be read, which must say so.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import SignupsTable, { type SignupRow } from './SignupsTable';

afterEach(cleanup);

const NOW = new Date('2026-11-02T15:30:00Z');
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

const ROWS: SignupRow[] = [
  {
    id: 'u1',
    email: 'trial@example.org',
    name: 'Trial Person',
    createdAt: h(2),
    lastActiveAt: h(0.25),
    tripCount: 2,
    entitlement: { ok: true, state: 'trial', entitled: true, enforced: true, trialEndsAt: new Date(NOW.getTime() + 5.5 * 86_400_000) },
  },
  {
    id: 'u2',
    email: 'ghost@example.org',
    name: null,
    createdAt: h(30),
    lastActiveAt: null,
    tripCount: 0,
    entitlement: { ok: true, state: 'trial_expired', entitled: true, enforced: false, trialEndsAt: null },
  },
  {
    id: 'u3',
    email: 'broken@example.org',
    name: 'Broken',
    createdAt: h(40),
    lastActiveAt: h(39),
    tripCount: 1,
    entitlement: { ok: false, error: 'connection reset' },
  },
];

describe('SignupsTable', () => {
  it('shows joined, last active, trips and entitlement for each signup, linking to the user', () => {
    render(<SignupsTable rows={ROWS} now={NOW} />);
    const rows = screen.getAllByTestId('signup-row');
    expect(rows).toHaveLength(3);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: /Trial Person/ })).toHaveAttribute('href', '/admin/users/u1');
    expect(rows[0]).toHaveTextContent('2h ago');
    expect(rows[0]).toHaveTextContent('15m ago');
    expect(rows[0]).toHaveTextContent('trial');
    expect(rows[0]).toHaveTextContent('has access · trial ends in 6d');
  });

  it('a signup with no activity says so, and an unenforced paywall is called out', () => {
    render(<SignupsTable rows={ROWS} now={NOW} />);
    const ghost = screen.getAllByTestId('signup-row')[1];
    expect(ghost).toHaveTextContent('no activity yet');
    expect(ghost).toHaveTextContent('trial_expired');
    expect(ghost).toHaveTextContent('paywall off');
    expect(ghost).toHaveTextContent('ghost@example.org');
  });

  it('a verdict that failed to read says so instead of guessing a state', () => {
    render(<SignupsTable rows={ROWS} now={NOW} />);
    expect(screen.getAllByTestId('signup-row')[2]).toHaveTextContent('read failed: connection reset');
  });

  it('says when the window is empty', () => {
    render(<SignupsTable rows={[]} now={NOW} />);
    expect(screen.getByText('No signups in this window.')).toBeInTheDocument();
  });
});
