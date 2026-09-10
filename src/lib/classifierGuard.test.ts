import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The tier classifier is the only place in the lockdown work that points a
 * model at an untrusted user message, so the shape of that call is the
 * security property — not the prompt, which is advice, but the SURFACE, which
 * is enforced by the API.
 *
 * The lockdown, and what each line buys:
 *
 *  - EXACTLY ONE tool, and `tool_choice` forces it. The model cannot answer in
 *    prose, cannot call anything else, and there is nothing else to call. A
 *    second tool in that array is the whole difference between "the worst a
 *    hostile message can do is get itself misfiled" and "the worst it can do
 *    is whatever the second tool does".
 *  - `additionalProperties: false` and a closed `enum` on the tier, so the
 *    answer cannot carry a field or a value the server did not ask for.
 *  - `max_tokens: 60`. No room to be talked into an essay, and no reason to
 *    pay for one.
 *  - No history and no database tools.
 *
 * Asserted as source text because none of it is expressible as a type: the SDK
 * accepts any number of tools and any max_tokens perfectly happily.
 */

/**
 * BOTH halves. The request (tool, system prompt, ceilings) is a pure module so
 * `scripts/measure-message-gate.ts` can send the exact request the app sends —
 * a measurement built from a hand-copied prompt is evidence about the copy, not
 * about the app. Reading them together means the guard cannot be satisfied by
 * moving a rule across the seam.
 */
const CALL_SITE = readFileSync(join(__dirname, '..', 'server', 'pennyClassifier.ts'), 'utf8');
const PROMPT = readFileSync(join(__dirname, 'pennyClassifierPrompt.ts'), 'utf8');
const SRC = `${CALL_SITE}\n${PROMPT}`;

describe('the classifier call is locked down', () => {
  it('passes exactly ONE tool', () => {
    // The array literal, as written. A second entry here is the finding.
    const m = SRC.match(/tools:\s*\[([^\]]*)\]/);
    expect(m, 'no tools array found — did the call move?').not.toBeNull();
    const entries = m![1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(entries).toEqual(['CLASSIFY_TOOL']);
  });

  it('FORCES that tool, so the model cannot answer in prose', () => {
    expect(SRC).toMatch(/tool_choice:\s*\{\s*type:\s*'tool',\s*name:\s*'classify_message'\s*\}/);
  });

  it('declares exactly one tool object in the file', () => {
    // Catches the other half: a second tool defined and passed somewhere the
    // regex above does not look.
    const declared = SRC.match(/:\s*Anthropic\.Tool\s*=/g) ?? [];
    expect(declared.length).toBe(1);
  });

  it('closes the schema — no extra properties, and a fixed set of tiers', () => {
    expect(SRC).toMatch(/additionalProperties:\s*false/);
    expect(SRC).toMatch(/enum:\s*\['T1',\s*'T2',\s*'T3'\]/);
  });

  it('caps the answer at 60 tokens', () => {
    expect(PROMPT).toMatch(/CLASSIFY_MAX_TOKENS = 60\b/);
    expect(CALL_SITE).toMatch(/max_tokens:\s*CLASSIFY_MAX_TOKENS\b/);
  });

  it('re-validates the tier instead of trusting the enum', () => {
    // The enum is in the schema, so an off-contract answer should be
    // impossible — which is exactly why it is checked. A model that answered
    // with a fourth value must not be able to put it in the tier column.
    expect(PROMPT).toMatch(/export function isTier\(/);
    expect(PROMPT).toMatch(/if \(!isTier\(tier\)\) return null;/);
    expect(CALL_SITE).toMatch(/if \(!parsed\)/);
  });

  it('sends no conversation history', () => {
    // One user message, built here. A history would carry the driver's whole
    // itinerary — and every earlier injection attempt — into a call that
    // exists to read one sentence.
    // `[\s\S]` rather than the `s` flag: the tsconfig target predates it.
    const msgs = CALL_SITE.match(/messages:\s*\[([\s\S]*?)\],/);
    expect(msgs, 'no messages array found').not.toBeNull();
    expect(msgs![1]).not.toMatch(/history|previous|\.\.\./);
    expect((msgs![1].match(/role:/g) ?? []).length).toBe(1);
  });

  it('tells the model the message is untrusted and is not addressed to it', () => {
    expect(SRC).toMatch(/untrusted/i);
    expect(SRC).toMatch(/never answer/i);
  });

  it('is biased to allow, in the schema AND the system prompt', () => {
    // A false T3 refuses a real driver mid-trip; a false T1 costs $0.085 and
    // reaches Penny, who can say she cannot help. The breakers bound how many
    // of those there can be.
    expect(SRC).toMatch(/WHEN UNSURE, ANSWER T1/);
    expect(SRC).toMatch(/Bias to T1/);
  });

  it('fails OPEN, to T1, on every failure path', () => {
    // No key, a timeout, a thrown SDK error, a malformed result. The gate is an
    // optimisation with teeth, not a security boundary — everything expensive
    // is still behind the circuit breakers.
    for (const path of ['no api key', 'no tool call', 'bad tier', 'classifier failed']) {
      const line = SRC.split('\n').find((l) => l.includes(`'${path}'`));
      expect(line, `no failure path for "${path}"`).toBeTruthy();
      expect(line, `"${path}" must fail open to T1`).toMatch(/tier: 'T1'/);
    }
  });

  it('runs on the cheap model from the registry, never a literal', () => {
    expect(CALL_SITE).toMatch(/model: CLASSIFY_MODEL/);
    expect(SRC).not.toMatch(/model: 'claude-/);
  });

  it('is only reached when the free deciders could not settle it', () => {
    const gate = readFileSync(join(__dirname, '..', 'server', 'messageGate.ts'), 'utf8');
    const deterministic = gate.indexOf('decideDeterministically(');
    const classify = gate.indexOf('classifyMessage(');
    expect(deterministic, 'the gate does not run the free deciders').toBeGreaterThan(-1);
    expect(classify, 'the gate does not call the classifier').toBeGreaterThan(-1);
    expect(deterministic).toBeLessThan(classify);
    // And only when the first returned nothing.
    expect(gate).toMatch(/if \(!decision\) \{[\s\S]{0,200}classifyMessage\(/);
  });
});
