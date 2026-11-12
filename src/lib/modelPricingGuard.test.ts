import { describe, expect, it } from 'vitest';

import { estimateAnthropicCostUsd } from './anthropicCostEstimate';
import * as models from './models';

/**
 * Every spend cap — the trial's daily dollars, the 12-month ceiling, the
 * breakers — reads the cost written on each usage row, and that cost comes
 * from `estimateAnthropicCostUsd`. A model it has no price for comes back as
 * $0 with only a console.warn, so changing a model ID in models.ts without a
 * price row would make every call free as far as every cap can tell.
 *
 * This holds the two files together: any model the app calls must price above
 * zero, and at the rate the model actually bills.
 */
const EXPECTED_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

const ids = [...new Set((Object.values(models) as unknown[]).filter((v): v is string => typeof v === 'string'))];

describe('every model the app calls has a price', () => {
  it.each(ids)('%s prices above $0', (id) => {
    expect(estimateAnthropicCostUsd(id, 1_000_000, 0)).toBeGreaterThan(0);
    expect(estimateAnthropicCostUsd(id, 0, 1_000_000)).toBeGreaterThan(0);
  });

  it.each(ids)('%s prices at its list rate', (id) => {
    const want = EXPECTED_PER_MTOK[id];
    expect(want, `add ${id}'s list price to EXPECTED_PER_MTOK`).toBeDefined();
    expect(estimateAnthropicCostUsd(id, 1_000_000, 0)).toBeCloseTo(want.input, 6);
    expect(estimateAnthropicCostUsd(id, 0, 1_000_000)).toBeCloseTo(want.output, 6);
    // Cache: writes 1.25×, reads 0.10× of input — Haiku 5.5's $0.125 / $0.01.
    expect(estimateAnthropicCostUsd(id, 0, 0, 1_000_000, 0)).toBeCloseTo(want.input * 1.25, 6);
    expect(estimateAnthropicCostUsd(id, 0, 0, 0, 1_000_000)).toBeCloseTo(want.input * 0.1, 6);
  });
});
