import { describe, expect, it } from 'vitest';

import {
  DATE_PARSE_MODEL,
  ONBOARDING_SCAN_MODEL,
  PENNY_MODEL,
  RANGE_ESTIMATE_MODEL,
} from './models';

/**
 * Which model Penny runs on is a cost decision, not a detail.
 *
 * Sonnet → Haiku is a 3× price change in both directions, and the direction that
 * hurts is silent: a one-word edit to `models.ts` in an unrelated commit puts
 * every planning turn back on Sonnet, and nothing fails, nothing warns, and the
 * bill arrives a month later. The Austin 14-leg turn measured $0.585 on Sonnet
 * against $0.085 on Haiku for the same prompt.
 *
 * So the model lives in a test as well as in a constant: going back to Sonnet is
 * allowed, but it has to be done ON PURPOSE, in a diff that says so.
 */
describe('model registry', () => {
  it('runs Penny on Haiku', () => {
    expect(PENNY_MODEL).toMatch(/^claude-haiku-/);
  });

  it('runs every one-shot extraction on Haiku too', () => {
    // These were never anything else — they are trivial forced-tool calls and
    // Penny's planning model would be waste. Pinned so a well-meaning
    // "use one model everywhere" tidy-up has to argue with a test.
    for (const id of [DATE_PARSE_MODEL, RANGE_ESTIMATE_MODEL, ONBOARDING_SCAN_MODEL]) {
      expect(id).toMatch(/^claude-haiku-/);
    }
  });

  it('pins exact dated model ids, never a floating alias', () => {
    // `claude-haiku-4-5` without the date is a moving target: the app would
    // change behaviour on Anthropic's schedule rather than on ours.
    for (const id of [PENNY_MODEL, DATE_PARSE_MODEL, RANGE_ESTIMATE_MODEL, ONBOARDING_SCAN_MODEL]) {
      expect(id).toMatch(/-\d{8}$/);
    }
  });
});
