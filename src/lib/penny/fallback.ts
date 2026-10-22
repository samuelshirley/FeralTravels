import { looksLikeLeakedToolCall } from './sanitize';

/** Why a turn fell back to "couldn't apply that cleanly" — the facts, not the text. */
export interface PennyFallback {
  /** The would-be-final text still looked like tool-call markup written as text. */
  leakedMarkup: boolean;
  /** Corrective retries already spent on leaked markup this turn (0 or 1). */
  leakRetries: number;
  /** Length of the raw text before sanitizing — 0 means the model said nothing. */
  rawChars: number;
  /** Text blocks in the final response. */
  chunks: number;
  /** The final response's stop_reason. */
  stopReason: string | null;
}

/**
 * The fallback record for a turn whose final text sanitized to nothing, or null
 * when the turn did apply actions (that path says "Done — take a look at the
 * updated plan." and is not a dead end).
 */
export function pennyFallbackFor(input: {
  appliedActions: number;
  iterationText: readonly string[];
  leakRetryCount: number;
  stopReason: string | null | undefined;
}): PennyFallback | null {
  if (input.appliedActions > 0) return null;
  const joined = input.iterationText.join('\n\n');
  return {
    leakedMarkup: looksLikeLeakedToolCall(joined),
    leakRetries: input.leakRetryCount,
    rawChars: joined.length,
    chunks: input.iterationText.length,
    stopReason: input.stopReason ?? null,
  };
}
