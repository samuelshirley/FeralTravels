/**
 * Unit tests for the server-side auto-continue helper.
 *
 * When a planning turn truncates, the loop in `claude.ts` re-runs within the
 * same request and appends a continuation nudge to the running message list.
 * It MUST NOT create two consecutive user turns — the Anthropic API rejects
 * that. `appendContinuationNudge` owns the invariant, so we pin it here.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { appendContinuationNudge, AUTO_CONTINUE_PROMPT } from './autoContinue';

type MessageParam = Anthropic.MessageParam;

describe('appendContinuationNudge', () => {
  it('appends a text block to a trailing user tool_results turn (no new turn)', () => {
    // The real truncation state: the last message is the user turn carrying
    // tool_results for the prior assistant turn.
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'plan my trip' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'add_leg', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'Validated and queued.' },
        ],
      },
    ];

    appendContinuationNudge(messages, 'keep going');

    // No new message — the nudge rode along on the existing user turn.
    expect(messages).toHaveLength(3);
    const last = messages[2];
    expect(last.role).toBe('user');
    const content = last.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('tool_result');
    expect(content[1]).toEqual({ type: 'text', text: 'keep going' });
  });

  it('never produces two consecutive user turns', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ];

    appendContinuationNudge(messages, 'continue');

    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
  });

  it('pushes a fresh user turn when the last message is an assistant turn', () => {
    // Defensive branch — shouldn't happen at truncation, but must stay valid.
    const messages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    appendContinuationNudge(messages, 'continue');

    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([{ type: 'text', text: 'continue' }]);
  });

  it('falls back to the default prompt when none is provided', () => {
    const messages: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    appendContinuationNudge(messages);

    const content = messages[1].content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(AUTO_CONTINUE_PROMPT);
    expect(content[0].text.length).toBeGreaterThan(0);
  });
});
