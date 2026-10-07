/**
 * Contact Support (opened from the account menu). One POST to /api/support;
 * a failure must stay on screen with the user's text intact so they can try
 * again — losing a typed support message to a silent error is the worst case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SupportModal from './SupportModal';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function textarea() {
  return screen.getByLabelText('How can we help?') as HTMLTextAreaElement;
}

describe('SupportModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<SupportModal open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on the form with Send disabled until there is a message', () => {
    render(<SupportModal open onClose={vi.fn()} />);
    expect(screen.getByText('Contact Support')).toBeInTheDocument();
    expect(textarea()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(textarea(), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends the trimmed message as JSON to POST /api/support and confirms', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    render(<SupportModal open onClose={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: '  The map is blank  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/support');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'The map is blank' });
  });

  it('shows "Sending..." and blocks a double submit while in flight', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    render(<SupportModal open onClose={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'Help' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const sending = await screen.findByRole('button', { name: 'Sending...' });
    expect(sending).toBeDisabled();
    fireEvent.submit(textarea().closest('form') as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(json({ ok: true }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
  });

  it('a non-2xx answer is shown, and the typed message is kept', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, 500));
    render(<SupportModal open onClose={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'Penny is stuck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(textarea()).toHaveValue('Penny is stuck');
    expect(screen.queryByText('Message sent')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('a rejected fetch (offline) is shown too', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SupportModal open onClose={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'Offline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(textarea()).toHaveValue('Offline');
  });

  it('Cancel, the × and Escape all close', () => {
    const onClose = vi.fn();
    render(<SupportModal open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('cannot be closed mid-send (the message would be lost without an answer)', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const onClose = vi.fn();
    render(<SupportModal open onClose={onClose} />);
    fireEvent.change(textarea(), { target: { value: 'Help' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Sending...' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closing from the sent state resets the form for next time', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const onClose = vi.fn();
    const { rerender } = render(<SupportModal open onClose={onClose} />);
    fireEvent.change(textarea(), { target: { value: 'Thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Message sent');

    // Two buttons are labelled Close here: the header × and the body button.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<SupportModal open={false} onClose={onClose} />);
    rerender(<SupportModal open onClose={onClose} />);
    await waitFor(() => expect(textarea()).toHaveValue(''));
  });
});
