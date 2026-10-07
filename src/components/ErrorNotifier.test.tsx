/**
 * ErrorNotifier is the global half of "never silently swallow errors": every
 * apiFetch call that does not opt out lands here. 4xx is a toast, 5xx and
 * network failures are the full-screen modal. Driven through the REAL
 * apiFetch with a mocked fetch, because the registration between the two is
 * the thing under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/sillyErrors', () => ({
  pickSillyError: () => ({
    headline: 'Penny chased a squirrel through the server room.',
    body: 'Give it a moment and try again.',
    emoji: '🐿️',
  }),
}));

import ErrorNotifier from './ErrorNotifier';
import { apiFetch } from '@/lib/api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

async function failingCall(path: string, opts: Parameters<typeof apiFetch>[1] = {}) {
  await act(async () => {
    await apiFetch(path, opts).catch(() => undefined);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ErrorNotifier — 4xx toast', () => {
  it('shows the status and the server message for a 4xx', async () => {
    fetchMock.mockResolvedValue(json({ error: 'That stop no longer exists' }, 404));
    render(<ErrorNotifier />);
    await failingCall('/api/stops/abc');

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('404');
    expect(toast).toHaveTextContent('That stop no longer exists');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('carries the server error id, and copies it on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fetchMock.mockResolvedValue(json({ error: 'Bad input', errorId: 'err_4xx_1' }, 400));
    render(<ErrorNotifier />);
    await failingCall('/api/trips');

    const badge = screen.getByRole('button', { name: 'err_4xx_1' });
    fireEvent.click(badge);
    expect(writeText).toHaveBeenCalledWith('err_4xx_1');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('the Dismiss control closes the toast', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Forbidden' }, 403));
    render(<ErrorNotifier />);
    await failingCall('/api/trips/x');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('the toast clears itself after five seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ error: 'Too many requests' }, 429));
    render(<ErrorNotifier />);
    await failingCall('/api/chat');
    expect(screen.getByRole('status')).toHaveTextContent('Too many requests');

    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ErrorNotifier — 5xx / network modal', () => {
  it('a 5xx opens the modal with the technical details behind a toggle', async () => {
    fetchMock.mockResolvedValue(json({ error: 'database timeout', errorId: 'err_5xx_9' }, 503));
    render(<ErrorNotifier />);
    await failingCall('/api/trip');

    const dialog = screen.getByRole('alertdialog', {
      name: 'Penny chased a squirrel through the server room.',
    });
    expect(dialog).toHaveTextContent('Give it a moment and try again.');
    expect(screen.queryByText('HTTP 503')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show technical details' }));
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
    expect(screen.getByText('/api/trip')).toBeInTheDocument();
    expect(screen.getByText('database timeout')).toBeInTheDocument();
    expect(screen.getByText('ID: err_5xx_9')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a rejected fetch (offline) is a modal that names the network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ErrorNotifier />);
    await failingCall('/api/stops');

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show technical details' }));
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
  });

  it('Dismiss closes the modal', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    render(<ErrorNotifier />);
    await failingCall('/api/trip');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('Reload marks the retry and shows progress instead of firing twice', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    render(<ErrorNotifier />);
    await failingCall('/api/trip');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    const reloading = screen.getByRole('button', { name: 'Reloading…' });
    expect(reloading).toBeDisabled();
    expect(sessionStorage.getItem('tp-error-retry')).not.toBeNull();
  });

  it('a repeat failure right after a reload says it is still broken', async () => {
    sessionStorage.setItem('tp-error-retry', String(Date.now()));
    fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
    render(<ErrorNotifier />);
    await failingCall('/api/trip');

    expect(screen.getByRole('alertdialog', { name: 'Still chasing that squirrel.' })).toBeInTheDocument();
  });
});

describe('ErrorNotifier — registration', () => {
  it('a call that opts out with skipGlobalErrorReport shows nothing', async () => {
    fetchMock.mockResolvedValue(json({ error: 'handled inline' }, 500));
    render(<ErrorNotifier />);
    await failingCall('/api/trips/1', { skipGlobalErrorReport: true });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a successful call shows nothing', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    render(<ErrorNotifier />);
    await act(async () => {
      await apiFetch('/api/me');
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
