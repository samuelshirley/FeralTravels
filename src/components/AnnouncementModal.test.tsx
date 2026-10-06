/**
 * The one-time announcement popup on /trips: GET the newest undismissed
 * announcement, show it, POST a dismissal when the CTA is clicked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AnnouncementModal from './AnnouncementModal';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ANNOUNCEMENT = {
  id: 'ann-1',
  title: 'Fuel prices on the map',
  body: 'Stations now show along every drive.',
  buttonText: 'Got it',
};

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let dismissResponse: () => Promise<Response>;

beforeEach(() => {
  dismissResponse = async () => json({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/announcements/active') return json({ announcement: ANNOUNCEMENT });
    if (url === '/api/announcements/dismiss') return dismissResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dismissCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === '/api/announcements/dismiss');
}

describe('AnnouncementModal', () => {
  it('fetches the active announcement and shows its title, body and button', async () => {
    render(<AnnouncementModal />);
    expect(await screen.findByRole('heading', { name: ANNOUNCEMENT.title })).toBeInTheDocument();
    expect(screen.getByText(ANNOUNCEMENT.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith('/api/announcements/active');
  });

  it('renders nothing when there is no announcement', async () => {
    fetchMock.mockImplementation(async () => json({ announcement: null }));
    const { container } = render(<AnnouncementModal />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed load renders nothing (there is no announcement to show)', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<AnnouncementModal />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('the button POSTs the dismissal as JSON and then closes the modal', async () => {
    render(<AnnouncementModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));

    await waitFor(() => expect(dismissCalls()).toHaveLength(1));
    const [, init] = dismissCalls()[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ announcementId: 'ann-1' });
    await waitFor(() =>
      expect(screen.queryByTestId('announcement-modal')).not.toBeInTheDocument()
    );
  });

  it('the button is disabled while the dismissal is in flight (no double POST)', async () => {
    dismissResponse = () => new Promise<Response>(() => {});
    render(<AnnouncementModal />);
    const button = await screen.findByRole('button', { name: 'Got it' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(dismissCalls()).toHaveLength(1);
  });

  /*
   * BUG (convention: never silently swallow errors) — src/components/AnnouncementModal.tsx:45-56.
   * handleDismiss never checks `res.ok` and its catch is empty, so a 500 (or an
   * offline POST) closes the modal exactly as a success does. The user is told
   * nothing and the announcement comes back on the next visit. The code comment
   * calls this "best-effort"; the convention says a failed mutation is shown.
   */
  it.fails('a failed dismissal is shown to the user', async () => {
    dismissResponse = async () => json({ error: 'database unavailable' }, 500);
    render(<AnnouncementModal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(dismissCalls()).toHaveLength(1));

    expect(await screen.findByRole('alert', {}, { timeout: 500 })).toBeInTheDocument();
  });
});
