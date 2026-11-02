/** The trips list behind the "Active trips" tile. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import TripsTable from './TripsTable';

afterEach(cleanup);

const NOW = new Date('2026-11-02T15:30:00Z');

describe('TripsTable', () => {
  it('links each trip to its chat and its owner to the user page, with legs and dates', () => {
    render(
      <TripsTable
        now={NOW}
        rows={[
          {
            id: 't1',
            name: 'Girona → Nordkapp',
            userId: 'u1',
            userEmail: 'a@example.org',
            userName: 'Ana',
            legCount: 14,
            startDateParsed: '2026-11-10',
            updatedAt: new Date(NOW.getTime() - 3 * 60_000),
          },
          {
            id: 't2',
            name: 'Orphan',
            userId: null,
            userEmail: null,
            userName: null,
            legCount: 0,
            startDateParsed: null,
            updatedAt: new Date(NOW.getTime() - 2 * 86_400_000),
          },
        ]}
      />
    );
    const [a, b] = screen.getAllByTestId('trip-row');
    expect(within(a).getByRole('link', { name: 'Girona → Nordkapp' })).toHaveAttribute('href', '/admin/chats/t1');
    expect(within(a).getByRole('link', { name: 'Ana' })).toHaveAttribute('href', '/admin/users/u1');
    expect(a).toHaveTextContent('14');
    expect(a).toHaveTextContent('2026-11-10');
    expect(a).toHaveTextContent('3m ago');
    expect(b).toHaveTextContent('(deleted user)');
    expect(b).toHaveTextContent('2d ago');
  });

  it('says when there are none', () => {
    render(<TripsTable now={NOW} rows={[]} />);
    expect(screen.getByText('No trips yet.')).toBeInTheDocument();
  });
});
