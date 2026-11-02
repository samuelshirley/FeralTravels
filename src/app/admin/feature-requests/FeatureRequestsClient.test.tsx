/**
 * /admin/feature-requests — add, filter, set status, reply, delete.
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. The
 * server half (routes, repo, cascades) has its own tests; this pins what each
 * control SENDS, that a failure is said inline, and that delete needs the
 * confirm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import FeatureRequestsClient, { type AdminFeatureRequestRow } from './FeatureRequestsClient';

const FUEL = '00000000-0000-4000-8000-0000000000f1';
const WEATHER = '00000000-0000-4000-8000-0000000000f2';
const CAMP = '00000000-0000-4000-8000-0000000000f3';

const ROWS: AdminFeatureRequestRow[] = [
  {
    id: FUEL,
    title: 'Fuel prices at each stop',
    body: 'Show the price at the stations Finn picks.',
    status: 'in_progress',
    reply: 'Working on it.',
    voteCount: 14,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
  },
  {
    id: WEATHER,
    title: 'Weather along the route',
    body: null,
    status: 'open',
    reply: null,
    voteCount: 9,
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
  },
  {
    id: CAMP,
    title: 'Book campsites in the app',
    body: null,
    status: 'not_doing',
    reply: 'Booking stays with the campsite.',
    voteCount: 1,
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let respond: (c: Call) => Response;

beforeEach(() => {
  calls = [];
  respond = (c) => (c.method === 'GET' ? json({ requests: ROWS }) : json({ ok: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(c);
      return respond(c);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (id: string) => screen.getByTestId(`admin-feature-request-${id}`);
const writes = () => calls.filter((c) => c.method !== 'GET');

describe('FeatureRequestsClient', () => {
  it('shows each request with its vote count, and the counts per status', () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    expect(within(row(FUEL)).getByText('14')).toBeTruthy();
    expect(within(row(FUEL)).getByText('VOTES')).toBeTruthy();
    expect(within(row(CAMP)).getByText('VOTE')).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['All 3', 'Open 1', 'In progress 1', 'Not doing 1']);
  });

  it('the filter narrows the list', () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(screen.getByRole('tab', { name: /Not doing/ }));
    expect(screen.queryByTestId(`admin-feature-request-${FUEL}`)).toBeNull();
    expect(row(CAMP)).toBeTruthy();
  });

  it('adds a request, then re-reads the list', async () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Share a trip  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
    expect(writes()).toEqual([
      { url: '/api/admin/feature-requests', method: 'POST', body: { title: 'Share a trip', body: null } },
    ]);
  });

  it('a failed add is said inline, and the title is kept', async () => {
    respond = () => json({ error: 'Invalid request' }, 400);
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Share a trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not added: Invalid request (HTTP 400)');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Share a trip');
  });

  it('a status button sends that status for that request', async () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(WEATHER)).getByRole('radio', { name: 'In progress' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: `/api/admin/feature-requests/${WEATHER}`,
      method: 'PATCH',
      body: { status: 'in_progress' },
    });
  });

  it('the current status is checked and pressing it sends nothing', () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    const current = within(row(FUEL)).getByRole('radio', { name: 'In progress' });
    expect(current.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(current);
    expect(writes()).toEqual([]);
  });

  it('a request with no reply shows the editor; saving sends the trimmed reply', async () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    const box = within(row(WEATHER)).getByLabelText('Reply (shown in the app)');
    fireEvent.change(box, { target: { value: '  Soon.  ' } });
    fireEvent.click(within(row(WEATHER)).getByRole('button', { name: 'Save reply' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ reply: 'Soon.' });
  });

  it('on a Not doing request the reply is labelled as the reason', () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(CAMP)).getByRole('button', { name: 'Edit' }));
    expect(within(row(CAMP)).getByLabelText('Reason (shown in the app)')).toBeTruthy();
  });

  it('Remove reply sends null', async () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Remove reply' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: `/api/admin/feature-requests/${FUEL}`, method: 'PATCH', body: { reply: null } });
  });

  it('delete asks first, names the votes it destroys, and sends nothing on Cancel', async () => {
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Delete' }));
    expect(writes()).toEqual([]);
    expect(within(row(FUEL)).getByText(/its reply and its 14 votes/)).toBeTruthy();
    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Cancel' }));
    expect(writes()).toEqual([]);

    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row(FUEL)).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: `/api/admin/feature-requests/${FUEL}`, method: 'DELETE', body: undefined });
  });

  it('a failed change is said on that row', async () => {
    respond = (c) => (c.method === 'GET' ? json({ requests: ROWS }) : json({ error: 'not_found' }, 404));
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(WEATHER)).getByRole('radio', { name: 'Not doing' }));
    expect(await within(row(WEATHER)).findByRole('alert')).toHaveTextContent('Status change failed: not_found (HTTP 404)');
  });

  it('a change that saved but could not re-read says so', async () => {
    respond = (c) => (c.method === 'GET' ? json({}, 500) : json({ ok: true }));
    render(<FeatureRequestsClient initialRows={ROWS} />);
    fireEvent.click(within(row(WEATHER)).getByRole('radio', { name: 'Not doing' }));
    expect(await screen.findByText(/Saved, but the list did not reload/)).toBeTruthy();
  });
});
