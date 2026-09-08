/**
 * The free-text opening description keeps its plain bubbles.
 *
 * `collapseOnboardingSteps` says a step that offered NO options has no widget
 * to redraw — "rendering it as one enormous pill under its own question is
 * worse than the plain question-then-answer bubbles it replaced" — so it keeps
 * the question row. But both ChatPanels drew the answered-step widget for ANY
 * `form_answer` row carrying `form_meta`, and the server writes meta on every
 * one of them. So the opening description got the worst of both: the question
 * bubble stayed AND the answer became the pill, with the driver's own words no
 * longer a user bubble at all.
 *
 * That is what red-lit `onboarding-flow.spec.ts` on PR #28
 * (`userBubble('Road trip to Berlin')` → 0), and it is reproduced here in
 * milliseconds rather than in a five-minute preview deploy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ChatMessage } from '@/types/trip';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async () => ({})),
}));
vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';

const OPENING = 'Road trip to Berlin';
const OPENING_Q = "Where are we going? One city is enough to start — I'll sort the fuel.";
const PACE_Q = 'How long do you want to drive each day?';

function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    seq: 0,
    trip_id: 't1',
    role: 'user',
    content: '',
    kind: 'chat',
    changes_made: null,
    plan_summary: null,
    form_meta: null,
    ...over,
  } as ChatMessage;
}

/** The rows the server writes for a step, in the order it writes them. */
const step = (
  n: number,
  question: string,
  answer: string,
  options: { value: string; label: string }[],
  selected: string | null
): ChatMessage[] => [
  msg({ id: `q${n}`, seq: n * 2, role: 'assistant', content: question, kind: 'form_question' }),
  msg({
    id: `a${n}`,
    seq: n * 2 + 1,
    role: 'user',
    content: answer,
    kind: 'form_answer',
    form_meta: { question, kind: options.length ? 'chips' : 'text', options, selected, answerLabel: answer },
  }),
];

const messages: ChatMessage[] = [
  // Step 1 — free text. No options were offered, so nothing can be redrawn.
  ...step(1, OPENING_Q, OPENING, [], null),
  // Step 2 — chips. This one SHOULD become the widget; it is the control that
  // proves the fix narrows the renderer rather than switching it off.
  ...step(2, PACE_Q, '6 h a day', [
    { value: '4', label: '4 h' },
    { value: '6', label: '6 h' },
    { value: '8', label: '8 h' },
  ], '6'),
];

describe('an answered step only replaces the bubbles when it has something to redraw', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as never;
  });

  const renderPanel = () =>
    render(
      <ChatPanel tripId="t1" initialMessages={messages} onboardingState={undefined} onTripUpdated={() => {}} />
    );

  it("keeps the driver's own opening words as a user bubble", async () => {
    renderPanel();
    await waitFor(() => {
      const bubbles = screen
        .queryAllByTestId('chat-message')
        .filter((el) => el.getAttribute('data-message-role') === 'user');
      expect(bubbles.some((el) => el.textContent?.includes(OPENING))).toBe(true);
    });
  });

  it('does not turn the free-text opening into an answered-step pill', async () => {
    renderPanel();
    await waitFor(() => expect(screen.queryAllByTestId('chat-answered-step').length).toBeGreaterThan(0));
    const pills = screen.queryAllByTestId('chat-answered-step');
    expect(pills.some((el) => el.textContent?.includes(OPENING))).toBe(false);
  });

  it('still redraws a step that DID offer options', async () => {
    renderPanel();
    await waitFor(() => {
      const pills = screen.queryAllByTestId('chat-answered-step');
      expect(pills.some((el) => el.textContent?.includes('How long do you want to drive'))).toBe(true);
    });
    // And that answer is not ALSO a right-aligned bubble.
    const bubbles = screen
      .queryAllByTestId('chat-message')
      .filter((el) => el.getAttribute('data-message-role') === 'user');
    expect(bubbles.some((el) => el.textContent?.includes('6 h a day'))).toBe(false);
  });
});
