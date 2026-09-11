import { describe, expect, it } from 'vitest';

import {
  buildTurnTrace,
  promptFingerprint,
  TRACE_MAX_FIELD_CHARS,
  TRACE_MAX_TOTAL_CHARS,
  traceStringify,
  traceToolCall,
  truncateField,
  type TracedModelCall,
} from './turnTrace';

/**
 * What a turn sent and what it was told, kept so a bug can be READ.
 *
 * `penny_turns.result_meta` held tool NAMES only. Investigating the 2026-09-10
 * Zion turn meant re-running `resolve_place` by hand and guessing that the
 * coordinates matched what Penny had actually been handed. They did. Nothing in
 * the database said so, and the next investigation would have had to guess
 * again.
 */

describe('truncateField', () => {
  it('leaves anything inside the cap alone, and says so', () => {
    expect(truncateField('short', 10)).toEqual({ text: 'short', truncated: false });
    expect(truncateField('exactly-10', 10)).toEqual({ text: 'exactly-10', truncated: false });
  });

  it('cuts to the cap and REPORTS the cut', () => {
    // Silence is the failure mode: a trace that quietly loses its tail reads as
    // a complete record of a shorter turn, which is worse than no trace at all.
    const { text, truncated } = truncateField('a'.repeat(50), 10);
    expect(text).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it('defaults to the documented field cap', () => {
    expect(truncateField('x'.repeat(TRACE_MAX_FIELD_CHARS + 1)).text).toHaveLength(
      TRACE_MAX_FIELD_CHARS,
    );
  });
});

describe('traceStringify', () => {
  it('renders a tool input as JSON', () => {
    expect(traceStringify({ destination_place_id: 'ChIJ2fhE' })).toBe(
      '{"destination_place_id":"ChIJ2fhE"}',
    );
  });

  it('never throws on a value that cannot be serialised', () => {
    // A tool input is whatever the model emitted. Taking down the turn we are
    // trying to describe would be an absurd way to lose one.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(traceStringify(circular)).toBe('[unserialisable]');
    expect(traceStringify(undefined)).toBe('undefined');
  });
});

describe('traceToolCall', () => {
  it('records the name, the input, the result and whether it errored', () => {
    const call = traceToolCall(
      'get_route',
      { destination_lat: 37.2982022, destination_lng: -113.0263005 },
      'get_route failed: no_results — No driving route found.',
      true,
    );
    expect(call.name).toBe('get_route');
    expect(call.input).toContain('37.2982022');
    expect(call.result).toContain('no_results');
    expect(call.is_error).toBe(true);
    // Nothing was cut, so the flags are absent rather than false — an intact
    // trace carries no noise about truncation that did not happen.
    expect(call.input_truncated).toBeUndefined();
    expect(call.result_truncated).toBeUndefined();
  });

  it('flags each field independently when it cuts one', () => {
    const call = traceToolCall('get_route', { note: 'x'.repeat(5000) }, 'ok', false);
    expect(call.input_truncated).toBe(true);
    expect(call.result_truncated).toBeUndefined();
    expect(call.input.length).toBe(TRACE_MAX_FIELD_CHARS);
  });
});

describe('promptFingerprint', () => {
  it('is stable for the same prompt and tools', () => {
    expect(promptFingerprint('system', [{ name: 'a' }])).toBe(
      promptFingerprint('system', [{ name: 'a' }]),
    );
  });

  it('changes when the PROMPT changes', () => {
    // The question it exists to answer: were these two turns planned against
    // the same instructions?
    expect(promptFingerprint('system', [])).not.toBe(promptFingerprint('system!', []));
  });

  it('changes when the TOOL SET changes', () => {
    // A tool schema edit changes Penny's behaviour as surely as a prompt edit,
    // and hashing only the prompt would report two different turns identical.
    expect(promptFingerprint('system', [{ name: 'a' }])).not.toBe(
      promptFingerprint('system', [{ name: 'a' }, { name: 'b' }]),
    );
  });

  it('is short, hex, and not the prompt itself', () => {
    const hash = promptFingerprint('x'.repeat(60_000), []);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // ~13,800 tokens, byte-identical across every call in a turn. Storing it
    // per turn is megabytes a month for no information.
    expect(hash.length).toBeLessThan(20);
  });
});

/** N model calls, each with one tool call of roughly `size` characters. */
function calls(n: number, size = 100): TracedModelCall[] {
  return Array.from({ length: n }, (_, i) => ({
    tools: ['get_route'],
    calls: [traceToolCall('get_route', { i }, 'r'.repeat(size), false)],
  }));
}

describe('buildTurnTrace', () => {
  it('keeps a normal turn whole and says nothing about truncation', () => {
    // The Zion turn was 9 model calls / 28 tool calls — the shape this is
    // sized for. A trace that truncated the case it was built for would be
    // useless on arrival.
    const trace = buildTurnTrace('abc123', calls(9, 500));
    expect(trace.calls).toHaveLength(9);
    expect(trace.truncated).toBeUndefined();
    expect(trace.omitted_model_calls).toBeUndefined();
    expect(trace.prompt_hash).toBe('abc123');
  });

  it('drops from the END and states how many it dropped', () => {
    const trace = buildTurnTrace('h', calls(200, 2_000));
    expect(trace.truncated).toBe(true);
    expect(trace.omitted_model_calls).toBe(200 - trace.calls.length);
    expect(trace.calls.length).toBeGreaterThan(0);
  });

  it('keeps the OLDEST calls, because that is where the bug is', () => {
    // A failure cascade is read from its start: the first ZERO_RESULTS is the
    // bug and the nineteenth is the consequence.
    const trace = buildTurnTrace('h', calls(200, 2_000));
    expect(trace.calls[0].calls[0].input).toContain('{"i":0}');
  });

  it('never drops a partial model call', () => {
    // Half a model call in the record invites exactly the wrong reading: that
    // the turn made fewer tool calls than it did.
    const trace = buildTurnTrace('h', calls(200, 2_000));
    for (const call of trace.calls) expect(call.calls).toHaveLength(1);
  });

  it('keeps the first call whatever it costs', () => {
    /*
     * A trace with no calls in it says LESS than the tool-name list it was
     * meant to improve on.
     *
     * One model call can exceed the whole-turn cap on its own, because the
     * per-FIELD cap is applied first and a single call can still emit many
     * tools — Penny batches `resolve_place` for every named point in one
     * response, and the Zion turn put twenty `get_route` calls across nine.
     */
    const huge: TracedModelCall = {
      tools: Array.from({ length: 100 }, () => 'get_route'),
      calls: Array.from({ length: 100 }, (_, i) =>
        traceToolCall('get_route', { i }, 'r'.repeat(TRACE_MAX_FIELD_CHARS), false),
      ),
    };
    const trace = buildTurnTrace('h', [huge, ...calls(2)]);
    expect(trace.calls).toHaveLength(1);
    expect(trace.truncated).toBe(true);
    expect(trace.omitted_model_calls).toBe(2);
  });

  it('stays within an order of the stated cap', () => {
    // The number in CLAUDE.md is the promise; this is the check that the
    // promise is about the same thing the code does.
    const trace = buildTurnTrace('h', calls(500, 2_000));
    expect(JSON.stringify(trace).length).toBeLessThan(TRACE_MAX_TOTAL_CHARS * 2);
  });
});
