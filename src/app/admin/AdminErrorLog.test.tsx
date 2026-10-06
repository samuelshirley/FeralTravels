/**
 * The provider-error table on /admin and its detail modal.
 *
 * Pure render from props — no request. Pins the empty state, one row per
 * error with relative time and who it hit, and the detail modal opening on a
 * row click and closing on Close or a backdrop click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import AdminErrorLog, { type AdminErrorRow } from './AdminErrorLog';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const ROWS: AdminErrorRow[] = [
  {
    id: 41,
    createdAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
    provider: 'anthropic',
    errorMessage: 'overloaded_error',
    tripId: 'trip_abc',
    userId: 'u_1',
    userEmail: 'ada@example.com',
    userName: 'Ada',
  },
  {
    id: 42,
    createdAt: new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
    provider: 'google:directions',
    errorMessage: null,
    tripId: null,
    userId: null,
    userEmail: null,
    userName: null,
  },
];

describe('AdminErrorLog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // Renders from props only; any request is a bug.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says so when nothing was logged', () => {
    render(<AdminErrorLog rows={[]} />);
    expect(screen.getByText('No errors logged in this window. Nice and quiet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders one row per error: when, who, provider, message', () => {
    render(<AdminErrorLog rows={ROWS} />);
    const bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);

    const first = within(bodyRows[0]);
    expect(first.getByText('5m ago')).toBeInTheDocument();
    expect(first.getByText('Ada')).toBeInTheDocument();
    expect(first.getByText('ada@example.com')).toBeInTheDocument();
    expect(first.getByText('anthropic')).toBeInTheDocument();
    expect(first.getByText('overloaded_error')).toBeInTheDocument();

    const second = within(bodyRows[1]);
    expect(second.getByText('3d ago')).toBeInTheDocument();
    expect(second.getByText('(anon)')).toBeInTheDocument();
    expect(second.getByText('(no message)')).toBeInTheDocument();
  });

  it('a row click opens the detail, with the trip linked and the user id', () => {
    render(<AdminErrorLog rows={ROWS} />);
    expect(screen.queryByText('Error 41')).toBeNull();

    fireEvent.click(screen.getByText('overloaded_error'));

    expect(screen.getByText('Error 41')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#trip_abc' })).toHaveAttribute('href', '/trips/trip_abc');
    expect(screen.getByText('id: u_1')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(ROWS[0].createdAt.replace(/[.]/g, '\\.')))).toBeInTheDocument();
  });

  it('the detail for an anonymous, tripless error says what is missing', () => {
    render(<AdminErrorLog rows={ROWS} />);
    fireEvent.click(screen.getByText('(anon)'));
    expect(screen.getByText('Error 42')).toBeInTheDocument();
    expect(screen.getByText('(no trip context)')).toBeInTheDocument();
    expect(screen.getByText('(no message recorded)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Close closes the detail', () => {
    render(<AdminErrorLog rows={ROWS} />);
    fireEvent.click(screen.getByText('overloaded_error'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Error 41')).toBeNull();
  });

  it('a click inside the detail keeps it open; a backdrop click closes it', () => {
    render(<AdminErrorLog rows={ROWS} />);
    fireEvent.click(screen.getByText('overloaded_error'));

    fireEvent.click(screen.getByText('Error 41'));
    expect(screen.getByText('Error 41')).toBeInTheDocument();

    // The backdrop is the panel's parent: the outermost element of the modal.
    const panel = screen.getByText('Error 41').closest('div[style*="max-width"]');
    expect(panel).not.toBeNull();
    fireEvent.click(panel!.parentElement!);
    expect(screen.queryByText('Error 41')).toBeNull();
  });
});
