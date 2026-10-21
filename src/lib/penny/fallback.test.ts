import { describe, expect, it } from 'vitest';
import { pennyFallbackFor } from './fallback';

describe('pennyFallbackFor', () => {
  it('is null when the turn applied actions ("Done — take a look" is not a dead end)', () => {
    expect(pennyFallbackFor({ appliedActions: 2, iterationText: [''], leakRetryCount: 0, stopReason: 'end_turn' })).toBeNull();
  });

  it('records an empty reply: no text at all', () => {
    expect(pennyFallbackFor({ appliedActions: 0, iterationText: [], leakRetryCount: 0, stopReason: 'end_turn' })).toEqual({
      leakedMarkup: false,
      leakRetries: 0,
      rawChars: 0,
      chunks: 0,
      stopReason: 'end_turn',
    });
  });

  it('records leaked tool-call markup that the retry did not recover', () => {
    const leaked = '<invoke name="add_leg"><parameter name="start">Girona</parameter></invoke>';
    const f = pennyFallbackFor({ appliedActions: 0, iterationText: [leaked], leakRetryCount: 1, stopReason: 'end_turn' });
    expect(f).toMatchObject({ leakedMarkup: true, leakRetries: 1, rawChars: leaked.length, chunks: 1 });
  });

  it('keeps a missing stop_reason as null rather than inventing one', () => {
    expect(pennyFallbackFor({ appliedActions: 0, iterationText: [' '], leakRetryCount: 0, stopReason: undefined })?.stopReason).toBeNull();
  });
});
