import { describe, expect, it } from 'vitest';

import { gateRowFromUsage, jevRowFromUsage } from './gateLedger';

/**
 * `/api/test/turn`'s `gate-ledger` action hands a fixture account's gate and
 * Jev rows to a Maestro flow running on a CI runner, whose output is a log
 * anyone with the repo can read. The rows sit next to a driver's words: a
 * Haiku gate reason paraphrases the message, and `meta` is jsonb. So the
 * mapping must pick fields, never pass them through.
 */
const SECRET = 'my passport number is X1234567';

describe('gate rows', () => {
  it('reads the tier and decider of a Jev-settled message', () => {
    expect(gateRowFromUsage({ model: 'T1', errorMessage: 'T1 by classifier: jev T1 p=0.99' })).toEqual({
      tier: 'T1',
      by: 'classifier',
      byJev: true,
    });
  });

  it('tells Haiku apart from Jev, and drops Haiku\'s reason', () => {
    const row = gateRowFromUsage({ model: 'T3', errorMessage: `T3 by classifier: user said "${SECRET}"` });
    expect(row).toEqual({ tier: 'T3', by: 'classifier', byJev: false });
    expect(JSON.stringify(row)).not.toContain('passport');
  });

  it('reads a free-rule decision', () => {
    expect(gateRowFromUsage({ model: 'T1', errorMessage: 'T1 by allow_rule: trip vocabulary' })).toEqual({
      tier: 'T1',
      by: 'allow_rule',
      byJev: false,
    });
  });

  it('an unreadable row is no decider, not a guess', () => {
    expect(gateRowFromUsage({ model: 'T1', errorMessage: null })).toEqual({ tier: 'T1', by: null, byJev: false });
  });
});

describe('Jev rows', () => {
  it('picks the four numbers the flow asserts on', () => {
    expect(
      jevRowFromUsage({
        success: true,
        meta: { mode: 'user', choice: 'T1', top: 0.73, margin: 0.5, settled: false, deferredReason: 'below_t1_min' },
      })
    ).toEqual({ success: true, choice: 'T1', top: 0.73, settled: false, deferredReason: 'below_t1_min' });
  });

  it('never passes another key through, and no text in a typed one', () => {
    const row = jevRowFromUsage({
      success: false,
      meta: { choice: 'T1', top: SECRET, settled: SECRET, echoedModel: SECRET, message: SECRET },
    });
    expect(Object.keys(row).sort()).toEqual(['choice', 'deferredReason', 'settled', 'success', 'top']);
    expect(JSON.stringify(row)).not.toContain('passport');
  });

  it('a row with no meta is all nulls', () => {
    expect(jevRowFromUsage({ success: false, meta: null })).toEqual({
      success: false,
      choice: null,
      top: null,
      settled: null,
      deferredReason: null,
    });
  });
});
