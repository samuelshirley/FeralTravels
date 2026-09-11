import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every Penny turn records what its model calls were. Decision B6.
 *
 * One user message is not one API call: it is a tool-use loop of up to
 * MAX_TOOL_USE_ITERATIONS model calls times MAX_AUTO_CONTINUES, and each one
 * re-reads a ~23,300-token cached prefix — which is where roughly two thirds of
 * a turn's cost goes. Real measured turns have been 7, 9 and 37 calls.
 *
 * Before `toolTrace`, a 37-call turn was a number on a bill with nothing
 * recording what those calls were, which is exactly the position the Sonnet →
 * Haiku comparison could not have been made from. Its LENGTH is the prefix
 * re-read count.
 */

const ROOT = join(__dirname, '..', '..');
const claude = readFileSync(join(ROOT, 'src/lib/claude.ts'), 'utf8');
const route = readFileSync(join(ROOT, 'src/app/api/trip/replan/route.ts'), 'utf8');
const turnsRoute = readFileSync(join(ROOT, 'src/app/api/trips/[id]/turns/route.ts'), 'utf8');

describe('toolTrace survives the whole path', () => {
  it('is declared on the result type', () => {
    expect(claude).toMatch(/toolTrace:\s*string\[\]\[\]/);
  });

  it('is pushed to inside the tool-use loop', () => {
    // One entry per MODEL CALL, including the text-only final one, so the
    // length is the call count and not the tool count.
    expect(claude).toMatch(/toolTrace\.push\(/);
  });

  it('is returned from the stream', () => {
    expect(claude).toMatch(/\n\s*toolTrace,/);
  });

  it('reaches the applied payload as toolTrace AND modelCalls', () => {
    // penny_turns.result_meta is built from this payload; without both fields
    // the durable record cannot answer "how many calls did that turn cost".
    expect(route).toMatch(/toolTrace:\s*final\.toolTrace/);
    expect(route).toMatch(/modelCalls:\s*final\.toolTrace\.length/);
  });
});

/**
 * …and what those calls SENT and were TOLD. Decision B12.
 *
 * Names alone answer "how many times did we re-read the prefix" and nothing
 * else. Investigating the 2026-09-10 Zion turn meant re-running `resolve_place`
 * by hand and GUESSING that the coordinates matched the ones Penny had been
 * handed — which is not a method, it is a coincidence that happened to hold.
 */
describe('the turn trace records the calls themselves', () => {
  it('is built from the SAME tool_results the model was shown', () => {
    // Re-reading the inputs from `toolUses` instead would be a second version
    // of the truth, free to disagree with the one that actually ran.
    expect(claude).toMatch(/new Map\(toolResults\.map\(\(r\) => \[r\.tool_use_id, r\]\)\)/);
    expect(claude).toMatch(/traceToolCall\(tu\.name, tu\.input,/);
  });

  it('carries a prompt fingerprint, not a copy of the prompt', () => {
    // ~13,800 tokens, identical across every call in a turn. A hash still
    // answers "were these two turns planned against the same instructions".
    expect(claude).toMatch(/promptFingerprint\(SYSTEM_PROMPT, TOOLS\)/);
    expect(claude).not.toMatch(/systemPrompt:\s*SYSTEM_PROMPT/);
  });

  it('is STORED but never streamed to the browser', () => {
    // It is a server-side record of tool inputs, several KB per turn, and the
    // client has no use for it. The live `applied` event never carried it, so
    // the heal path must not start.
    expect(route).toContain('resultMeta: { ...appliedPayload, turnTrace: final.turnTrace }');
    // The ONLY mention of it in the replan route is that one line — anything
    // else means it found its way onto the payload that goes over the wire.
    const mentions = route.match(/turnTrace/g) ?? [];
    expect(mentions).toHaveLength(2);
    // And the reconcile endpoint strips it back off.
    expect(turnsRoute).toContain('turnTrace: _trace');
  });
});
