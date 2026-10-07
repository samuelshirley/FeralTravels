/**
 * /admin/announcements — ship a new announcement, and switch existing ones on
 * and off.
 *
 * Component test, not e2e: /admin is behind a one-person allowlist. Errors here
 * surface through `window.alert` (the component's choice), so the tests assert
 * on that.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import AnnouncementsClient from './AnnouncementsClient';

interface Row {
  id: string;
  title: string;
  body: string;
  buttonText: string;
  active: boolean;
  createdAt: string;
  dismissCount: number;
}

const ROWS: Row[] = [
  {
    id: 'a1',
    title: 'Fuel prices are live',
    body: 'Finn now shows today’s prices.',
    buttonText: 'Nice',
    active: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    dismissCount: 12,
  },
  {
    id: 'a2',
    title: 'Old news',
    body: 'Something from last month.',
    buttonText: 'Got it',
    active: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    dismissCount: 3,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Handler = (init: RequestInit) => Promise<Response>;

function routedFetch(handlers: { list?: () => Promise<Response>; post?: Handler; patch?: Handler }) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    expect(url).toBe('/api/admin/announcements');
    const method = init?.method ?? 'GET';
    const h =
      method === 'POST' ? handlers.post : method === 'PATCH' ? handlers.patch : handlers.list;
    if (!h) return Promise.reject(new Error(`unexpected ${method}`));
    return h(init ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const titleInput = () => screen.getByPlaceholderText('Lots of Yuge updates');
const bodyInput = () => screen.getByPlaceholderText('What do you want to tell your users?');
const buttonTextInput = () => screen.getByPlaceholderText('Got it');
const shipButton = () => screen.getByRole('button', { name: /Ship it|Creating\.\.\./ });

let alertSpy: MockInstance<typeof window.alert>;

describe('AnnouncementsClient', () => {
  beforeEach(() => {
    refresh.mockReset();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    alertSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('lists each announcement with its state, button text and dismiss count', () => {
    render(<AnnouncementsClient initialRows={ROWS} />);
    expect(screen.getByText('Fuel prices are live')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('Button: "Nice"')).toBeInTheDocument();
    expect(screen.getByText('12 dismissed')).toBeInTheDocument();
    expect(screen.getByText('Old news')).toBeInTheDocument();
    expect(screen.getByText('INACTIVE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
  });

  it('says so when there are none', () => {
    render(<AnnouncementsClient initialRows={[]} />);
    expect(screen.getByText('No announcements yet. Ship one above.')).toBeInTheDocument();
  });

  it('cannot ship without a title and a body', () => {
    render(<AnnouncementsClient initialRows={[]} />);
    expect(shipButton()).toBeDisabled();
    fireEvent.change(titleInput(), { target: { value: 'Hello' } });
    expect(shipButton()).toBeDisabled();
    fireEvent.change(bodyInput(), { target: { value: '   ' } });
    expect(shipButton()).toBeDisabled();
    fireEvent.change(bodyInput(), { target: { value: 'World' } });
    expect(shipButton()).toBeEnabled();
  });

  it('ships the trimmed announcement, disabled in flight, then clears the form, refreshes and re-lists', async () => {
    const created: Row = { ...ROWS[1], id: 'a3', title: 'Hello', body: 'World', buttonText: 'Okay', active: true };
    let releasePost!: (r: Response) => void;
    const fetchMock = routedFetch({
      post: () => new Promise<Response>((r) => (releasePost = r)),
      list: async () => json([created, ...ROWS]),
    });
    render(<AnnouncementsClient initialRows={ROWS} />);

    fireEvent.change(titleInput(), { target: { value: '  Hello ' } });
    fireEvent.change(bodyInput(), { target: { value: ' World  ' } });
    fireEvent.change(buttonTextInput(), { target: { value: ' Okay ' } });
    fireEvent.click(shipButton());
    fireEvent.click(shipButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Hello', body: 'World', buttonText: 'Okay' });
    expect(shipButton()).toHaveTextContent('Creating...');
    expect(shipButton()).toBeDisabled();

    await act(async () => releasePost(json({ ok: true })));

    await waitFor(() => expect(screen.getByText('World')).toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(titleInput()).toHaveValue('');
    expect(bodyInput()).toHaveValue('');
    expect(buttonTextInput()).toHaveValue('Got it');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a blank button text ships as "Got it"', async () => {
    const fetchMock = routedFetch({ post: async () => json({}), list: async () => json(ROWS) });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.change(titleInput(), { target: { value: 'T' } });
    fireEvent.change(bodyInput(), { target: { value: 'B' } });
    fireEvent.change(buttonTextInput(), { target: { value: '  ' } });
    fireEvent.click(shipButton());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ buttonText: 'Got it' });
  });

  it('a non-2xx create is announced and the form keeps what was typed', async () => {
    routedFetch({ post: async () => json({ error: 'nope' }, 500) });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.change(titleInput(), { target: { value: 'Hello' } });
    fireEvent.change(bodyInput(), { target: { value: 'World' } });
    fireEvent.click(shipButton());

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to create announcement'));
    expect(titleInput()).toHaveValue('Hello');
    expect(refresh).not.toHaveBeenCalled();
    expect(shipButton()).toBeEnabled();
  });

  it('a rejected create is announced, not swallowed', async () => {
    routedFetch({ post: () => Promise.reject(new TypeError('Failed to fetch')) });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.change(titleInput(), { target: { value: 'Hello' } });
    fireEvent.change(bodyInput(), { target: { value: 'World' } });
    fireEvent.click(shipButton());
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to create announcement'));
  });

  it.each([
    ['Deactivate', 'a1', false],
    ['Activate', 'a2', true],
  ] as const)('"%s" PATCHes {id: %s, active: %s}, disabled in flight, then re-lists', async (label, id, active) => {
    let releasePatch!: (r: Response) => void;
    const flipped = ROWS.map((r) => (r.id === id ? { ...r, active } : r));
    const fetchMock = routedFetch({
      patch: () => new Promise<Response>((r) => (releasePatch = r)),
      list: async () => json(flipped),
    });
    render(<AnnouncementsClient initialRows={ROWS} />);

    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ id, active });
    expect(button).toBeDisabled();

    await act(async () => releasePatch(json({ ok: true })));

    await waitFor(() => expect(screen.queryAllByText('ACTIVE')).toHaveLength(active ? 2 : 0));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a rejected toggle is announced, not swallowed', async () => {
    routedFetch({ patch: () => Promise.reject(new TypeError('Failed to fetch')) });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to toggle'));
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
  });

  // A 4xx/5xx PATCH used to fall straight through to the list re-read, the row
  // stayed as it was, and nothing told the admin.
  it('a non-2xx toggle is announced', async () => {
    const fetchMock = routedFetch({
      patch: async () => json({ error: 'Injected failure' }, 500),
      list: async () => json(ROWS),
    });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to toggle'));
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    // No re-read after a refusal: there is nothing new to show.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // `rows` is seeded once from `initialRows`, so router.refresh() cannot fix a
  // failed re-read: it has to be said. And it must NOT say "failed to create" —
  // the announcement shipped, and the admin would ship it twice.
  it('a failed re-read after shipping is announced as shipped-but-stale', async () => {
    routedFetch({
      post: async () => json({ ok: true }),
      list: async () => json({ error: 'db down' }, 503),
    });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.change(titleInput(), { target: { value: 'Hello' } });
    fireEvent.change(bodyInput(), { target: { value: 'World' } });
    fireEvent.click(shipButton());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Saved, but the list did not reload. Refresh the page to see it.'),
    );
    expect(alertSpy).not.toHaveBeenCalledWith('Failed to create announcement');
    await waitFor(() => expect(shipButton()).toHaveTextContent('Ship it'));
  });

  it('a failed re-read after a toggle is announced', async () => {
    routedFetch({
      patch: async () => json({ ok: true }),
      list: async () => Promise.reject(new TypeError('Failed to fetch')),
    });
    render(<AnnouncementsClient initialRows={ROWS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Saved, but the list did not reload. Refresh the page to see it.'),
    );
  });
});
