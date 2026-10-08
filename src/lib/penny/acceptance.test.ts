import { describe, expect, it } from 'vitest';
import {
  acceptanceInstruction,
  classifyReply,
  detectAcceptance,
  lastQuestion,
  previousAssistantMessage,
} from './acceptance';
import { T2_MESSAGE, T3_MESSAGE } from '@/lib/pennyGate';

/**
 * A bare "yes" means "do what you just proposed" — decided in code.
 *
 * The incident (trip 9a3df982, 2026-10-08): Penny asked "Both good?", the
 * driver said "yup", and she asked another confirmation question. The words
 * and Penny's question below are the real ones from that trace.
 */

const BOTH_GOOD =
  "Two quick clarifications: for Ordesa y Monte Perdido, I'd go with the park's main visitor center in Torla-Ordesa, and for Tabernas I'd use the town itself as the base. Both good?";

describe('classifyReply', () => {
  it.each([
    'yup', 'Yes', 'yes!', 'YEP.', 'sure', 'ok', 'Okay 👍', 'sounds good', 'Sounds good!',
    'both good', 'Both good.', 'do it', 'go ahead', 'yes please', "let's do it", 'lets do it',
    'yea lets do them all', 'perfect, thanks', 'ok go ahead', 'yeah sounds great',
  ])('"%s" is an acceptance', (text) => {
    expect(classifyReply(text)).toBe('accept');
  });

  it.each([
    'whatever you choose', 'Whatever you choose.', 'you pick', 'up to you', "it's up to you",
    'your call', 'surprise me', 'either is fine', "I don't mind", 'whatever you think is best',
  ])('"%s" hands the choice over', (text) => {
    expect(classifyReply(text)).toBe('delegate');
  });

  it.each([
    'no', 'nope', 'the second one', 'undo that', 'yes but skip Tabernas',
    'yes and add Picos de Europa', 'can you add any offroad routes or gravel roads in there?',
    'I don\'t know any besides gorafe and its awesome and I wanna go there too',
    '', '   ', 'thanks', 'please', 'ok ok ok ok ok ok ok ok ok',
  ])('"%s" is not a bare acceptance', (text) => {
    expect(classifyReply(text)).toBeNull();
  });
});

describe('lastQuestion', () => {
  it('takes the last sentence that ends in a question mark', () => {
    expect(lastQuestion(BOTH_GOOD)).toBe('Both good?');
    expect(lastQuestion('Saved. Want me to add Gorafe? It is close.')).toBe('Want me to add Gorafe?');
    expect(lastQuestion('Loop is built.')).toBeNull();
  });
});

describe('previousAssistantMessage', () => {
  const chat = [
    { role: 'user' as const, content: 'plan a loop' },
    { role: 'assistant' as const, content: BOTH_GOOD },
    { role: 'user' as const, content: 'yup' },
  ];

  it("is Penny's message right before the driver's", () => {
    expect(previousAssistantMessage(chat, 'yup')).toBe(BOTH_GOOD);
  });

  it('is null when the driver sent two in a row', () => {
    expect(
      previousAssistantMessage([...chat.slice(0, 2), { role: 'user', content: 'hm' }, { role: 'user', content: 'yup' }], 'yup'),
    ).toBeNull();
  });

  it("is null when the message is not in the tail, or nothing precedes it", () => {
    expect(previousAssistantMessage(chat, 'something else')).toBeNull();
    expect(previousAssistantMessage([{ role: 'user', content: 'yup' }], 'yup')).toBeNull();
  });

  it("ignores the gate's own canned lines — they propose nothing", () => {
    for (const line of [T2_MESSAGE, T3_MESSAGE]) {
      expect(
        previousAssistantMessage([{ role: 'assistant', content: line }, { role: 'user', content: 'yes' }], 'yes'),
      ).toBeNull();
    }
  });
});

describe('detectAcceptance', () => {
  it('the incident: "yup" to "Both good?" is an acceptance', () => {
    expect(detectAcceptance('yup', BOTH_GOOD)).toEqual({ kind: 'accept', reply: 'yup', proposal: BOTH_GOOD });
  });

  it('"whatever you choose" after a question is a hand-off', () => {
    const a = detectAcceptance(
      'whatever you choose',
      'For the three others I need a specific spot — the Ordesa tracks or the Gorafe plateau?',
    );
    expect(a?.kind).toBe('delegate');
  });

  it("is null when Penny's message asked nothing", () => {
    expect(detectAcceptance('yup', 'Loop is built: Girona to the Pyrenees and back.')).toBeNull();
  });

  it('is null with no previous Penny message', () => {
    expect(detectAcceptance('yup', null)).toBeNull();
  });

  it('is null for an open invitation — "yes" there means "I have a change"', () => {
    expect(detectAcceptance('yes', 'Saved the loop. Want to adjust anything?')).toBeNull();
    expect(detectAcceptance('sure', 'Done. Anything else?')).toBeNull();
  });

  it('a plain "yes" to an either/or says nothing about which, so it is not forced', () => {
    expect(detectAcceptance('yes', 'Is this a stop along the way on day 2, or where you want to end the day?')).toBeNull();
    // ...but "you pick" answers exactly that.
    expect(detectAcceptance('you pick', 'Torla visitor centre or Bielsa?')?.kind).toBe('delegate');
  });

  it('is null when the reply carries an instruction of its own', () => {
    expect(detectAcceptance('yes but skip Tabernas', BOTH_GOOD)).toBeNull();
  });
});

describe('acceptanceInstruction', () => {
  it("quotes Penny's message and says to carry it out without asking again", () => {
    const text = acceptanceInstruction({ kind: 'accept', reply: 'yup', proposal: BOTH_GOOD });
    expect(text).toContain('<accepted_proposal>');
    expect(text).toContain(BOTH_GOOD);
    expect(text).toContain('"yup"');
    expect(text).toMatch(/Carry it out NOW with tools/);
    expect(text).toMatch(/Do NOT ask the user to confirm again/);
    expect(text).not.toMatch(/source="penny"/);
  });

  it('a hand-off also tells her the picks are hers: source="penny"', () => {
    const text = acceptanceInstruction({ kind: 'delegate', reply: 'whatever you choose', proposal: BOTH_GOOD });
    expect(text).toMatch(/source="penny", never source="user"/);
  });

  it('caps a very long proposal', () => {
    const long = `${'x'.repeat(5000)}?`;
    const text = acceptanceInstruction({ kind: 'accept', reply: 'yes', proposal: long });
    expect(text.length).toBeLessThan(3000);
  });
});
