import { describe, expect, it } from 'vitest';

import {
  buildClassifyContent,
  CLASSIFY_SYSTEM,
} from '@/lib/pennyClassifierPrompt';

import { MIN_MARGIN, settlesAsT1 } from './decide';
import { buildTierRequest, tierCriteria, TIER_LABELS, TIER_QUESTION_KEY } from './question';
import { readChoiceAnswer } from './schema';

/**
 * The System One adapter, on a REAL response and on our own question.
 *
 * `LAYA` is verbatim what Laya's open-source Jev-compatible server returned for
 * a place-intent question during the local CPU trial — kept as a fixture as it carries
 * the two traps a hand-written sample would not: a backend `confidence` of
 * 0.1473 on an answer whose own top probability is 0.5976, and extra fields
 * (`answer_confidence`, `action`, `routing`) that are not ours to read.
 */
const LAYA = {
  model: 'laya-rl-agent',
  answers: {
    place_intent: {
      type: 'choice',
      choice: 'end_of_day',
      probabilities: { end_of_day: 0.5976, along_route: 0.2575, unclear: 0.1448 },
      confidence: 0.1473,
      answer_confidence: 0.5976,
      action: { act_probability: 1.0 },
    },
  },
  usage: { input_tokens: 92, output_tokens: 0 },
  routing: {
    model: 'typed-decisions',
    repo: 'convaiinnovations/laya-typed-decisions',
    reason: "explicit model='typed-decisions'",
    detection: null,
    workflow: null,
  },
};

const PLACE_LABELS = ['end_of_day', 'along_route', 'unclear'] as const;

/** The same response, re-keyed to our tier question: T1 ← end_of_day, and so on. */
function asTier(choice: string, probabilities: Record<string, number>, extra: object = {}) {
  return {
    ...LAYA,
    answers: {
      [TIER_QUESTION_KEY]: { ...LAYA.answers.place_intent, choice, probabilities, ...extra },
    },
  };
}

describe('the captured Laya response', () => {
  it('reads the choice from OUR reading of probabilities, not the backend confidence', () => {
    const r = readChoiceAnswer(LAYA, 'place_intent', PLACE_LABELS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.choice).toBe('end_of_day');
    expect(r.reading.top).toBe(0.5976);
    expect(r.reading.margin).toBeCloseTo(0.5976 - 0.2575, 10);
    // 0.1473 appears nowhere in what we act on.
    expect(Object.values(r.reading)).not.toContain(0.1473);
    expect(r.reading.echoedModel).toBe('laya-rl-agent');
    expect(r.reading.inputTokens).toBe(92);
    expect(r.reading.outputTokens).toBe(0);
  });

  it('adapted to the tier question, a 0.60 T1 is read but does NOT settle', () => {
    const r = readChoiceAnswer(
      asTier('T1', { T1: 0.5976, T2: 0.2575, T3: 0.1448 }),
      TIER_QUESTION_KEY,
      TIER_LABELS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(settlesAsT1(r.reading, 0.85)).toEqual({ settled: false, reason: 'below_t1_min' });
  });
  it('a backend claiming high confidence on a weak answer does not make it strong', () => {
    // The mirror of Laya's trap: `confidence` ABOVE the top probability. The
    // only numbers that count are the probabilities.
    const r = readChoiceAnswer(
      asTier('T1', { T1: 0.6, T2: 0.3, T3: 0.1 }, { confidence: 0.99, answer_confidence: 0.99 }),
      TIER_QUESTION_KEY,
      TIER_LABELS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.top).toBe(0.6);
    expect(r.reading.margin).toBeCloseTo(0.3, 10);
    expect(settlesAsT1(r.reading, 0.85).settled).toBe(false);
  });
});

describe('the adapter rejects what we cannot act on', () => {
  const cases: Array<[string, unknown, string]> = [
    ['choice outside the enum', asTier('T4', { T1: 0.1, T2: 0.1, T3: 0.1 }), 'choice outside enum'],
    ['a probability for a label we never offered', asTier('T1', { T1: 0.9, T9: 0.1 }), 'probability outside enum'],
    ['a choice that is not the most probable', asTier('T1', { T1: 0.3, T2: 0.6, T3: 0.1 }), 'choice is not the most probable'],
    ['no probability for the choice', asTier('T1', { T2: 0.1 }), 'no probability for choice'],
    ['a probability above 1', asTier('T1', { T1: 1.5 }), 'answer shape'],
    ['a score answer where a choice was asked', asTier('T1', { T1: 0.9 }, { type: 'score' }), 'answer shape'],
    ['no answer for our key', LAYA, 'answer shape'],
    ['no answers object', { model: 'x' }, 'response shape'],
    ['not an object', 'T1', 'response shape'],
  ];
  it.each(cases)('%s', (_name, body, reason) => {
    const r = readChoiceAnswer(body, TIER_QUESTION_KEY, TIER_LABELS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('ignores unknown extra fields rather than failing on them', () => {
    const r = readChoiceAnswer(
      asTier('T1', { T1: 0.95, T2: 0.03, T3: 0.02 }, { novel_field: { deep: true } }),
      TIER_QUESTION_KEY,
      TIER_LABELS,
    );
    expect(r.ok).toBe(true);
  });
});

describe('the settle rule', () => {
  it('settles only a T1 at or above the threshold with a clear lead', () => {
    expect(settlesAsT1({ choice: 'T1', top: 0.95, margin: 0.9 }, 0.85)).toEqual({ settled: true });
    expect(settlesAsT1({ choice: 'T1', top: 0.85, margin: MIN_MARGIN }, 0.85)).toEqual({ settled: true });
  });

  it('never settles a T2 or a T3, however sure', () => {
    expect(settlesAsT1({ choice: 'T2', top: 1, margin: 1 }, 0.85)).toEqual({ settled: false, reason: 'not_t1' });
    expect(settlesAsT1({ choice: 'T3', top: 1, margin: 1 }, 0.85)).toEqual({ settled: false, reason: 'not_t1' });
  });

  it('defers a narrow lead even above the threshold', () => {
    expect(settlesAsT1({ choice: 'T1', top: 0.55, margin: 0.15 }, 0.5)).toEqual({
      settled: false,
      reason: 'margin',
    });
    expect(MIN_MARGIN).toBe(0.2);
  });

  it('treats NaN as not confident', () => {
    expect(settlesAsT1({ choice: 'T1', top: Number.NaN, margin: 1 }, 0.85).settled).toBe(false);
  });
});

describe('the tier question is the Haiku question', () => {
  it('cuts one criterion per tier out of the classifier tool description', () => {
    const c = tierCriteria();
    expect(Object.keys(c)).toEqual(['T1', 'T2', 'T3']);
    expect(c.T1).toMatch(/^about this road trip and actionable/);
    expect(c.T2).toMatch(/^about the trip but NOT something a route planner can do/);
    expect(c.T3).toMatch(/^junk/);
    for (const text of Object.values(c)) expect(text).not.toMatch(/\bT[123] = /);
  });

  it('sends instructions from CLASSIFY_SYSTEM and state from buildClassifyContent', () => {
    const ctx = { tripName: 'Norway run', places: ['Tromsø', 'Bodø'] };
    const req = buildTierRequest('any burgers near the ferry?', ctx, 'typed-decisions');
    expect(req.model).toBe('typed-decisions');
    expect(req.state).toBe(buildClassifyContent('any burgers near the ferry?', ctx));
    expect(req.questions[TIER_QUESTION_KEY]).toEqual({
      type: 'choice',
      instructions: CLASSIFY_SYSTEM,
      criteria: tierCriteria(),
    });
    expect(Object.keys(req.questions)).toEqual([TIER_QUESTION_KEY]);
  });
});
