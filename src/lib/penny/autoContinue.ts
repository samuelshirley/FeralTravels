import type Anthropic from "@anthropic-ai/sdk";

/**
 * Auto-continue helpers for the Penny tool-use loop.
 *
 * When a planning turn exhausts its per-pass iteration budget with tool work
 * still pending (truncation), the loop in `claude.ts` re-runs WITHIN the same
 * request — appending a short nudge so Penny finishes the remaining work. This
 * lives in its own module (pure, type-only Anthropic import) so the invariant
 * can be unit-tested without dragging in the server-side world claude.ts pulls.
 */

/**
 * Nudge appended when we auto-continue a truncated turn. The conversation is
 * already primed (Penny has pending tool_results to act on); this just focuses
 * her on finishing without re-emitting work that already succeeded.
 */
export const AUTO_CONTINUE_PROMPT =
  "You hit this turn's tool-step limit before finishing the plan. Continue from where you left off: emit the remaining tool calls (e.g. the rest of the add_leg days) until the plan is complete. Do NOT re-emit any tool call that already succeeded this turn.";

/**
 * Append the auto-continue nudge to the running message list WITHOUT creating
 * two consecutive user turns (which the Anthropic API rejects). At truncation
 * the last message is the tool_results user turn, so we add a text block to it;
 * if for any reason it isn't a user turn, we push a fresh user message.
 */
export function appendContinuationNudge(
  messages: Anthropic.MessageParam[],
  prompt: string = AUTO_CONTINUE_PROMPT,
): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text: prompt });
  } else {
    messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
  }
}
