import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Penny's <pasted_place_disambiguation> rule, read as text (SYSTEM_PROMPT is
 * module-private — same approach as toolTraceGuard.test.ts).
 *
 * Why: e2e/chat-maps-link.spec.ts pastes ONE Maps link, lands it as a stop,
 * then says "End day 1 at that place instead of central Annecy." Penny asked
 * whether "that place" meant the stop or the pasted link — the same place —
 * and never moved the leg end (failed 6/6 on 2026-09-26). The rule must say
 * that a single pasted place is the referent, and that its stop is not a
 * second candidate.
 */
const claude = readFileSync(join(__dirname, 'claude.ts'), 'utf8');
const rule = claude.match(
  /<pasted_place_disambiguation>([\s\S]*?)<\/pasted_place_disambiguation>/,
)?.[1];

describe('<pasted_place_disambiguation>', () => {
  it('exists in the system prompt', () => {
    expect(rule).toBeDefined();
  });

  it('treats "end day N at X" as explicit endpoint intent', () => {
    expect(rule).toMatch(/"end\/finish day N at X" → it's the day's endpoint/);
  });

  it('resolves "that place" to the single pasted place instead of asking', () => {
    expect(rule).toMatch(/When exactly ONE place was pasted and resolved, that is the referent/);
    expect(rule).toMatch(/do not ask which place they mean/);
  });

  it('does not count the stop made from that place as a second candidate', () => {
    expect(rule).toMatch(/already been added as a stop is not a second candidate/);
  });

  it('keeps the question for genuinely several candidates', () => {
    expect(rule).toMatch(/Ask which place only when there are genuinely several different candidates/);
  });
});
