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
