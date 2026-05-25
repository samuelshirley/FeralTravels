import { describe, it, expect } from 'vitest';
import { looksLikeLeakedToolCall, sanitizePennyText } from './sanitize';

describe('looksLikeLeakedToolCall', () => {
  it('detects an <invoke> tool call written as text', () => {
    const leaked =
      '<invoke name="add_stop"><parameter name="leg_id">abc</parameter></invoke>';
    expect(looksLikeLeakedToolCall(leaked)).toBe(true);
  });

  it('detects the antml-namespaced variant', () => {
    expect(
      looksLikeLeakedToolCall('<invoke name="add_leg">…</invoke>'),
    ).toBe(true);
  });

  it('detects a bare <function_calls> wrapper', () => {
    expect(looksLikeLeakedToolCall('<function_calls>')).toBe(true);
  });

  it('does not flag normal prose (even with angle brackets / comparisons)', () => {
    expect(
      looksLikeLeakedToolCall('Saved — 5h drive is < your 8h cap. Want to adjust?'),
    ).toBe(false);
  });
});

describe('sanitizePennyText', () => {
  it('strips a full <invoke> block but keeps surrounding prose', () => {
    const input =
      'Sure, adding that.\n<invoke name="add_stop"><parameter name="data">{"name":"Fugging"}</parameter></invoke>\nDone!';
    const out = sanitizePennyText(input);
    expect(out).not.toMatch(/invoke|parameter/i);
    expect(out).toContain('Sure, adding that.');
    expect(out).toContain('Done!');
  });

  it('returns empty string when the chunk is nothing but a leaked call', () => {
    const input =
      '<invoke name="add_stop"><parameter name="leg_id">c894764c</parameter><parameter name="data">{"stop_type":"other"}</parameter></invoke>';
    expect(sanitizePennyText(input)).toBe('');
  });

  it('removes the antml-namespaced form', () => {
    const input = 'Routing through Fugging.\n<invoke name="add_stop">x</invoke>';
    const out = sanitizePennyText(input);
    expect(out).toBe('Routing through Fugging.');
  });

  it('cleans up an empty code fence left behind by removal', () => {
    const input = 'Here:\n```\n<invoke name="add_leg">y</invoke>\n```';
    const out = sanitizePennyText(input);
    expect(out).toBe('Here:');
  });

  it('leaves clean prose untouched', () => {
    const input = 'Saved — kept your full Innsbruck stay. Want to adjust anything?';
    expect(sanitizePennyText(input)).toBe(input);
  });
});
