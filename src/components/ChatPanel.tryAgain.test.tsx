/**
 * "Try again" on Penny's dead end, in the web panel.
 *
 * The bubble offers it because the SERVER marked the reply a fallback
 * (`fallback_meta` on a reloaded row, `fallback` on a live `applied` frame) —
 * never because of what the reply says. Tapping it resends the previous
 * message through the panel's normal send path: the same POST to
 * /api/trip/replan, the same payload shape, the same error bubbles.
 * The native panel is held to the same wiring at source level by
 * src/lib/pennyTryAgainGuard.test.ts; its button is driven for real by
 * mobile/maestro/penny-try-again.yaml.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ChatMessage } from '@/types/trip';
import { resetPennyRuns } from '@/lib/pennyRunStore';

const INTENT = 'Girona to Lisbon, 5 h days';
/** Onboarding's last question; answering it ends setup and fires the hand-off. */
const LAST_STEP = {
  state: 'trip_intent',
  question: { key: 'trip_intent', kind: 'text', label: 'Where are we going?', prompts: [] },
  vehicles: [],
  progress: { current: 5, total: 5 },
};

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (path: string, opts: { method?: string } = {}) => {
    if (path === '/api/me') return { ai_consent: true };
    if (String(path).includes('/turns')) return { turn: null };
    if (String(path).includes('/onboarding')) {
      if ((opts.method ?? 'GET') === 'GET') return LAST_STEP;
      return { next: null, answerLabel: INTENT, didHandoff: true, tripIntent: INTENT };
    }
    return {};
  }),
}));
vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';

const TRIP = '00000000-0000-4000-8000-0000000000b1';
const FALLBACK = "Sorry, I couldn't apply that cleanly — could you rephrase and try again?";
const MESSAGE = 'Add a fuel stop in Porto';
const ANSWER = 'Added a fuel stop in Porto on day 2.';

function row(seq: number, over: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m${seq}`,
    seq,
    trip_id: TRIP,
    role: 'user',
    content: '',
    kind: 'ai',
    changes_made: null,
    plan_summary: null,
    form_meta: null,
    fallback_meta: null,
    created_at: '2026-10-21T10:00:00Z',
    ...over,
  };
}

/** The transcript as a reload returns it: the message, then Penny's dead end. */
const AFTER_FALLBACK: ChatMessage[] = [
  row(1, { role: 'user', content: MESSAGE }),
  row(2, { role: 'assistant', content: FALLBACK, fallback_meta: { images: 0 } }),
];

function sse(frames: Array<Record<string, unknown>>): Response {
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const appliedFrame = (response: string, fallback: { images: number } | null = null) => ({
  kind: 'applied',
  response,
  changes: { changes: [] },
  appliedCount: 0,
  failedCount: 0,
  failedActions: [],
  persistFailedCount: 0,
  persistFailedActions: [],
  validationFailures: [],
  validatedQueuedCount: 0,
  fuelStopsChanged: false,
  planSummary: null,
  truncated: false,
  fallback,
});

const fetchMock = vi.fn();
/**
 * What the next POST /api/trip/replan answers, one per send, then the default.
 * Routed by URL: the panel's other fetches (analytics beacons) must not
 * consume a queued replan answer.
 */
let replanQueue: Array<() => Promise<Response>> = [];
/** The next mount reads an account that is not entitled. */
let paywalledNext = false;
const nextReplan = (answer: () => Promise<Response>) => replanQueue.push(answer);
const replanCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url) === '/api/trip/replan');
const replanBody = (i: number) => JSON.parse(String(replanCalls()[i][1].body)) as Record<string, unknown>;

function renderPanel(messages: ChatMessage[], onActivity?: (s: string) => void) {
  return render(
    <ChatPanel
      tripId={TRIP}
      initialMessages={messages}
      onboardingState="done"
      onTripUpdated={() => {}}
      onActivity={onActivity as never}
    />,
  );
}

beforeEach(() => {
  resetPennyRuns();
  // jsdom has no scrollTo; the panel scrolls when a bubble lands.
  Element.prototype.scrollTo = vi.fn() as never;
  fetchMock.mockReset();
  replanQueue = [];
  paywalledNext = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url) === '/api/me/entitlement') {
      return new Response(JSON.stringify({ entitled: !paywalledNext }), { status: 200 });
    }
    if (String(url) !== '/api/trip/replan') return new Response('{}', { status: 200 });
    const queued = replanQueue.shift();
    return queued ? queued() : sse([{ kind: 'received' }, appliedFrame(ANSWER)]);
  });
  global.fetch = fetchMock as never;
});
afterEach(() => {
  cleanup();
  resetPennyRuns();
});

describe('which bubble offers "Try again"', () => {
  it("Penny's reply the server marked a fallback, labelled just \"Try again\"", async () => {
    renderPanel(AFTER_FALLBACK);
    const button = await screen.findByTestId('penny-try-again');
    expect(button.textContent).toBe('Try again');
    expect(screen.getAllByTestId('penny-try-again')).toHaveLength(1);
  });

  it('not on the same sentence without the flag — the button reads the flag, never the text', async () => {
    renderPanel([AFTER_FALLBACK[0], { ...AFTER_FALLBACK[1], fallback_meta: null }]);
    await screen.findByText(FALLBACK);
    expect(screen.queryByTestId('penny-try-again')).toBeNull();
  });

  it('not on an ordinary reply, and not on an older fallback Penny has answered since', async () => {
    renderPanel([
      ...AFTER_FALLBACK,
      row(3, { role: 'user', content: 'Add a night in Lisbon' }),
      row(4, { role: 'assistant', content: ANSWER }),
    ]);
    await screen.findByText(ANSWER);
    expect(screen.queryByTestId('penny-try-again')).toBeNull();
  });

  it('appears live, from the `applied` frame, when a send falls back', async () => {
    nextReplan(async () => sse([appliedFrame(FALLBACK, { images: 0 })]));
    renderPanel([]);
    const composer = (await screen.findByTestId('trip-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: MESSAGE } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(await screen.findByTestId('penny-try-again')).toBeTruthy();
  });

  it('not behind the paywall: the composer is closed there, and a resend could only be refused', async () => {
    paywalledNext = true;
    renderPanel(AFTER_FALLBACK);
    await screen.findByText(FALLBACK);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/me/entitlement')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('penny-try-again')).toBeNull();
  });
});

describe('tapping it', () => {
  it('resends the previous message through the normal replan request, and Penny answers', async () => {
    renderPanel(AFTER_FALLBACK);
    fireEvent.click(await screen.findByTestId('penny-try-again'));
    await screen.findByText(ANSWER);
    expect(replanCalls()).toHaveLength(1);
    expect(replanBody(0)).toMatchObject({ tripId: TRIP, message: MESSAGE, images: [], handoff: false });
    expect(typeof replanBody(0).idempotencyKey).toBe('string');
    // A newer message now follows the fallback: the button is gone.
    expect(screen.queryByTestId('penny-try-again')).toBeNull();
  });

  it('resends the onboarding hand-off as a hand-off, without drawing it as a user bubble', async () => {
    const intent = 'Girona to Lisbon, 5 h days';
    renderPanel([
      row(1, { role: 'user', kind: 'handoff', content: intent }),
      row(2, { role: 'assistant', content: FALLBACK, fallback_meta: { images: 0 } }),
    ]);
    fireEvent.click(await screen.findByTestId('penny-try-again'));
    await screen.findByText(ANSWER);
    expect(replanBody(0)).toMatchObject({ message: intent, handoff: true });
    expect(screen.queryByText(intent)).toBeNull();
  });

  it('a retried hand-off that falls back again offers it again, and resends the hand-off again', async () => {
    // Driving onboarding to its hand-off is other tests' job; here the panel
    // mounts straight after one, as a reload shows it, and the retry — itself a
    // live hand-off send — falls back again. Its "Try again" can only resend a
    // hand-off if the live send kept the hidden `handoff` row in state.
    nextReplan(async () => sse([appliedFrame(FALLBACK, { images: 0 })]));
    renderPanel([
      row(1, { role: 'user', kind: 'handoff', content: 'Girona to Lisbon' }),
      row(2, { role: 'assistant', content: FALLBACK, fallback_meta: { images: 0 } }),
    ]);
    fireEvent.click(await screen.findByTestId('penny-try-again'));
    // The retried hand-off fell back again: offered again, and resends the hand-off again.
    // The retried hand-off fell back too: a second fallback bubble, and the
    // button has moved onto it, enabled once that send has fully settled.
    await waitFor(() => expect(screen.getAllByText(FALLBACK)).toHaveLength(2));
    await waitFor(() =>
      expect((screen.getByTestId('penny-try-again') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('penny-try-again'));
    await screen.findByText(ANSWER);
    expect(replanCalls()).toHaveLength(2);
    expect(replanBody(1)).toMatchObject({ message: 'Girona to Lisbon', handoff: true });
    // Never drawn as something the driver typed.
    expect(screen.queryByText('Girona to Lisbon')).toBeNull();
  });

  it('a LIVE onboarding hand-off that falls back offers it, and resends the hand-off', async () => {
    // The panel's own hand-off send: the hidden `handoff` row it keeps in
    // state is the only user row that turn has — without it the nearest user
    // row is the setup answer, which is not something Penny can be resent.
    nextReplan(async () => sse([appliedFrame(FALLBACK, { images: 0 })]));
    render(
      <ChatPanel tripId={TRIP} initialMessages={[]} onboardingState="trip_intent" onTripUpdated={() => {}} />,
    );
    const composer = (await screen.findByTestId('trip-chat-composer')) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.disabled).toBe(false), { timeout: 5000 });
    fireEvent.change(composer, { target: { value: INTENT } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(replanCalls()).toHaveLength(1));
    expect(replanBody(0)).toMatchObject({ message: INTENT, handoff: true });

    const button = (await screen.findByTestId('penny-try-again')) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(ANSWER);
    expect(replanCalls()).toHaveLength(2);
    expect(replanBody(1)).toMatchObject({ message: INTENT, images: [], handoff: true });
  });

  it('is disabled while the resend is in flight: a double tap sends once', async () => {
    let release: (r: Response) => void = () => {};
    nextReplan(() => new Promise<Response>((r) => (release = r)));
    renderPanel(AFTER_FALLBACK);
    const button = (await screen.findByTestId('penny-try-again')) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(replanCalls()).toHaveLength(1));
    await act(async () => release(sse([appliedFrame(ANSWER)])));
    await screen.findByText(ANSWER);
    expect(replanCalls()).toHaveLength(1);
  });

  it('shows the failure inline when the resend fails — never swallowed', async () => {
    nextReplan(
      async () => new Response(JSON.stringify({ error: 'Daily AI spend cap reached ($5.00).' }), { status: 429 }),
    );
    renderPanel(AFTER_FALLBACK);
    fireEvent.click(await screen.findByTestId('penny-try-again'));
    expect(await screen.findByText('Error: Daily AI spend cap reached ($5.00).')).toBeTruthy();
  });

  it('shows a throw before the send could render its own outcome inline on the bubble', async () => {
    const onActivity = vi.fn((s: string) => {
      if (s === 'thinking') throw new Error('activity sink down');
    });
    renderPanel(AFTER_FALLBACK, onActivity);
    fireEvent.click(await screen.findByTestId('penny-try-again'));
    const alert = await screen.findByTestId('penny-try-again-error');
    expect(alert.textContent).toBe("Couldn't send that again: activity sink down");
  });
});

/*
 * Holding the live hand-off row (hidden) in state put one more message in
 * `messages` than in the drawn transcript, and the delivery receipt looked for
 * "a later user message" by TRANSCRIPT index in the MESSAGES list — so every
 * message after a hand-off lost its receipt. Reloaded transcripts, which always
 * carried the row, already had the bug; it now reads the transcript.
 */
describe('after a hidden hand-off row', () => {
  it('the newest message still shows its delivery receipt', async () => {
    renderPanel([
      row(1, { role: 'user', kind: 'handoff', content: INTENT }),
      row(2, { role: 'assistant', content: 'Here is your plan.' }),
    ]);
    const composer = (await screen.findByTestId('trip-chat-composer')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(ANSWER);
    // The receipt under the newest user bubble once Penny has answered.
    expect(await screen.findByText('Read')).toBeTruthy();
  });
});
