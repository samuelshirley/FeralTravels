/** The recent-chat list behind the "Recent chat" tile. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import ChatsTable from './ChatsTable';

afterEach(cleanup);

const NOW = new Date('2026-11-02T15:30:00Z');

describe('ChatsTable', () => {
  it('shows trip, owner, role, plan-edit marker and a clipped message, all opening the trip chat', () => {
    render(
      <ChatsTable
        now={NOW}
        rows={[
          {
            id: 'c1',
            tripId: 'trip-1',
            tripName: 'Morocco',
            userEmail: 'm@example.org',
            role: 'assistant',
            content: 'y'.repeat(300),
            hasChanges: true,
            createdAt: new Date(NOW.getTime() - 60_000),
          },
          {
            id: 'c2',
            tripId: 'abcdef12-0000-0000-0000-000000000000',
            tripName: null,
            userEmail: null,
            role: 'user',
            content: 'plan me a loop',
            hasChanges: false,
            createdAt: new Date(NOW.getTime() - 3_600_000),
          },
        ]}
      />
    );
    const [a, b] = screen.getAllByTestId('chat-row');
    expect(within(a).getByRole('link', { name: /Morocco/ })).toHaveAttribute('href', '/admin/chats/trip-1');
    expect(a).toHaveTextContent('m@example.org');
    expect(a).toHaveTextContent('edited plan');
    expect(a).toHaveTextContent(`${'y'.repeat(160)}…`);
    expect(a).not.toHaveTextContent('y'.repeat(161));
    expect(b).toHaveTextContent('#abcdef12');
    expect(b).not.toHaveTextContent('edited plan');
  });

  it('says when there is no chat', () => {
    render(<ChatsTable now={NOW} rows={[]} />);
    expect(screen.getByText('No chat activity yet.')).toBeInTheDocument();
  });
});
