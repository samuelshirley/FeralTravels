/**
 * sanitize.ts — keep tool-call markup out of Penny's conversational text.
 *
 * Penny invokes tools through the structured Anthropic tool-use interface; the
 * loop in claude.ts reads those as `tool_use` blocks and never shows them to the
 * user. But the model occasionally SERIALIZES a tool call as plain text instead
 * — emitting the raw function-call XML (e.g. `<invoke name="add_stop">…
 * <parameter name="data">…</parameter></invoke>`) inside a text block. When that
 * happens two bad things follow: the action never actually runs (it was never a
 * real tool call), and the user sees raw markup in the chat.
 *
 * Penny is a conversational wrapper — her text must be plain prose, full stop.
 * These pure helpers are the backstop that guarantees it: claude.ts uses
 * `looksLikeLeakedToolCall` to detect the failure (and give the model one
 * corrective turn so the real call fires), and `sanitizePennyText` to strip any
 * markup that still slips through before it's shown or persisted.
 *
 * Pure string functions — no I/O — so they're unit-testable.
 */

// Matches the opening/closing of any tool-call-ish tag, with or without the
// `antml:` namespace prefix the function-call format sometimes carries.
const TOOL_CALL_TAG = /<\/?\s*(?:antml:)?(?:function_calls|invoke|parameter)\b/i;

/**
 * True when the text looks like it contains a tool call written as prose rather
 * than issued through the tool interface. Intentionally broad: any stray
 * <function_calls>, <invoke>, or <parameter> tag trips it.
 */
export function looksLikeLeakedToolCall(text: string): boolean {
  return TOOL_CALL_TAG.test(text);
}

/**
 * Remove tool-call markup from a chunk of Penny's text. Strips whole
 * <function_calls>…</function_calls> and <invoke>…</invoke> blocks, then any
 * leftover stray tool-call tags, then collapses the empty code fences / blank
 * lines that removal can leave behind. Returns the cleaned, trimmed text — which
 * may be empty if the chunk was nothing but a leaked call (the caller supplies a
 * fallback in that case).
 */
export function sanitizePennyText(text: string): string {
  if (!text) return '';
  let out = text;

  // Whole balanced blocks first (handles nested <parameter> inside <invoke>).
  out = out.replace(
    /<\s*(?:antml:)?function_calls\b[\s\S]*?<\/\s*(?:antml:)?function_calls\s*>/gi,
    '',
  );
  out = out.replace(
    /<\s*(?:antml:)?invoke\b[\s\S]*?<\/\s*(?:antml:)?invoke\s*>/gi,
    '',
  );
  out = out.replace(
    /<\s*(?:antml:)?parameter\b[\s\S]*?<\/\s*(?:antml:)?parameter\s*>/gi,
    '',
  );

  // Any unbalanced / leftover tool-call tags (truncated stream, malformed close).
  out = out.replace(/<\/?\s*(?:antml:)?(?:function_calls|invoke|parameter)\b[^>]*>/gi, '');

  // Code fences that now wrap nothing but whitespace.
  out = out.replace(/```[a-zA-Z]*\s*```/g, '');

  // Collapse 3+ newlines left by removals, then trim.
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}
