import { describe, expect, it } from 'vitest';

import { buildTierRequest } from '@/server/jev/question';
import { buildClassifyContent, PREVIOUS_ASSISTANT_MAX_CHARS } from './pennyClassifierPrompt';

/**
 * What the classifier is shown. A reply ("yes do that") cannot be judged
 * without the message it replies to, so Penny's previous message travels, and
 * only its end, where her question is.
 */
const PENNY = 'I can push the start back a day, so day 1 is Saturday. Want me to do that?';

describe('buildClassifyContent', () => {
  it("puts Penny's previous message, labelled, between the trip and the message", () => {
    expect(
      buildClassifyContent('yes do that', { tripName: 'Norway', places: ['Alta'], previousAssistant: PENNY })
    ).toBe(`Trip: Norway\nPlaces on it: Alta\n\nPenny's previous message:\n${PENNY}\n\nMessage:\nyes do that`);
  });

  it('sends exactly what it sent before when there is no previous message', () => {
    for (const previousAssistant of [undefined, null, '', '   ']) {
      expect(buildClassifyContent('undo that', { tripName: 'Norway', previousAssistant })).toBe(
        'Trip: Norway\n\nMessage:\nundo that'
      );
    }
    expect(buildClassifyContent('undo that')).toBe('Message:\nundo that');
  });

  it(`keeps only the last ${PREVIOUS_ASSISTANT_MAX_CHARS} characters, where her question is`, () => {
    const long = `${'Day 1 runs along the fjord. '.repeat(40)}Shall I move it?`;
    const content = buildClassifyContent('yes', { previousAssistant: long });
    const block = content.split("Penny's previous message:\n")[1].split('\n\nMessage:')[0];
    expect(block).toBe(`…${long.slice(-PREVIOUS_ASSISTANT_MAX_CHARS)}`);
    expect(block.endsWith('Shall I move it?')).toBe(true);
    expect(block.length).toBe(PREVIOUS_ASSISTANT_MAX_CHARS + 1);
  });
});

describe("Jev's question", () => {
  it("is built by the same builder, so Jev sees Penny's previous message too", () => {
    const ctx = { tripName: 'Norway', places: ['Alta'], previousAssistant: PENNY };
    const req = buildTierRequest('yes do that', ctx, 'jev-1.13.0');
    expect(req.state).toBe(buildClassifyContent('yes do that', ctx));
    expect(req.state).toContain(`Penny's previous message:\n${PENNY}`);
  });
});
