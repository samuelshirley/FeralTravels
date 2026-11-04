/**
 * The web Feature requests list: what each vote click sends, the optimistic
 * count, putting the confirmed count back on failure, and the closed section.
 * The same rules as the iOS screen — both use src/lib/featureRequests.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { FeatureRequestView } from '@/lib/featureRequests';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import FeatureRequestsBoard from './FeatureRequestsBoard';

const WORKING = '00000000-0000-4000-8000-0000000000f1';
const OPEN = '00000000-0000-4000-8000-0000000000f2';
const CLOSED = '00000000-0000-4000-8000-0000000000f3';

const ROWS: FeatureRequestView[] = [
  { id: WORKING, title: 'Fuel prices at each stop', body: 'At the stations Finn picks.', status: 'in_progress', reply: 'Working on it.', voteCount: 14, votedByMe: true, createdAt: '2026-10-12T10:00:00.000Z' },
  { id: OPEN, title: 'Weather along the route', body: null, status: 'open', reply: null, voteCount: 9, votedByMe: false, createdAt: '2026-10-14T10:00:00.000Z' },
  { id: CLOSED, title: 'Book campsites in the app', body: null, status: 'not_doing', reply: 'Booking stays with the campsite.', voteCount: 3, votedByMe: false, createdAt: '2026-10-09T10:00:00.000Z' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls: { url: string; method: string }[];
let respond: (url: string, method: string) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  push.mockReset();
  respond = (url, method) =>
    method === 'GET' ? json({ requests: ROWS }) : json({ voteCount: method === 'PUT' ? 10 : 8, votedByMe: method === 'PUT' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      return respond(url, method);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const vote = (id: string) => screen.getByTestId(`feature-request-vote-${id}`);

describe('FeatureRequestsBoard', () => {
  it('shows the badge on the in-progress request and the reply under it', () => {
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    const card = screen.getByTestId(`feature-request-${WORKING}`);
    expect(within(card).getByRole('img', { name: 'In progress' })).toBeTruthy();
    expect(within(card).getByText('Working on it.')).toBeTruthy();
    expect(screen.queryByTestId(`feature-request-in-progress-${OPEN}`)).toBeNull();
  });

  it('a vote is a PUT, shown at once, then the server count replaces it', async () => {
    let release!: () => void;
    respond = (_url, method) =>
      method === 'PUT'
        ? new Promise<Response>((r) => (release = () => r(json({ voteCount: 12, votedByMe: true }))))
        : json({ requests: ROWS });
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    fireEvent.click(vote(OPEN));
    expect(vote(OPEN)).toHaveAttribute('aria-label', 'Remove your vote. 10 votes');
    expect(vote(OPEN)).toHaveAttribute('aria-pressed', 'true');
    release();
    await waitFor(() => expect(vote(OPEN)).toHaveAttribute('aria-label', 'Remove your vote. 12 votes'));
    expect(calls).toEqual([{ url: `/api/feature-requests/${OPEN}/vote`, method: 'PUT' }]);
  });

  it('taking a vote back is a DELETE', async () => {
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    fireEvent.click(vote(WORKING));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/api/feature-requests/${WORKING}/vote`, method: 'DELETE' });
  });

  it('a failed vote puts the confirmed count back and says why', async () => {
    respond = () => json({ error: 'boom' }, 500);
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    fireEvent.click(vote(OPEN));
    expect(await screen.findByRole('alert')).toHaveTextContent("Your vote didn't go through. Try again.");
    expect(vote(OPEN)).toHaveAttribute('aria-label', 'Vote. 9 votes');
  });

  it('a request closed meanwhile says so and re-reads the list', async () => {
    respond = (_url, method) => (method === 'GET' ? json({ requests: ROWS }) : json({ error: 'voting_closed' }, 409));
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    fireEvent.click(vote(OPEN));
    expect(await screen.findByRole('alert')).toHaveTextContent('Voting on this one has closed.');
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
  });

  it('signed out goes to /login', async () => {
    respond = () => json({ error: 'Unauthorized' }, 401);
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    fireEvent.click(vote(OPEN));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
  });

  it('a Not doing request shows its count and reason, and no vote button', () => {
    render(<FeatureRequestsBoard initialRows={ROWS} />);
    expect(screen.getByText('NOT DOING')).toBeTruthy();
    expect(screen.getByTestId(`feature-request-closed-${CLOSED}`)).toHaveAttribute('aria-label', '3 votes. Voting closed');
    expect(screen.queryByTestId(`feature-request-vote-${CLOSED}`)).toBeNull();
    expect(screen.getByText('Booking stays with the campsite.')).toBeTruthy();
  });
});
