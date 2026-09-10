import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicApiKey } from '@/lib/anthropicKey';
import { CLASSIFY_MODEL } from '@/lib/models';
import { logAnthropicUsageWithFallback } from '@/server/repos/usage';
import { dollarsToMicrocents, estimateAnthropicCostUsd } from '@/lib/anthropicCostEstimate';
import type { GateDecision } from '@/lib/pennyGate';
import {
  buildClassifyContent,
  readClassifyResult,
  CLASSIFY_MAX_TOKENS,
  CLASSIFY_SYSTEM,
  CLASSIFY_TOOL,
  type ClassifyContext,
} from '@/lib/pennyClassifierPrompt';

export type { ClassifyContext };

/**
 * The third decider: one Haiku call for the messages the free rules could not
 * settle.
 *
 * ── Why a model at all, when two regex layers already ran ──
 *
 * Because the alternative was a bigger keyword list, and that was argued down:
 * language does not enumerate. A list fails toward blocking real drivers
 * ("anything with a cheeseburger between Marfa and Big Bend" contains no trip
 * vocabulary at all) and fails open against the attacker anyway, who reads the
 * list and includes the word "trip". The deterministic layers are therefore
 * held to what NO driver types and what EVERY driver types, and the ambiguous
 * middle costs about $0.0005 — one 170th of the planning turn it is deciding
 * whether to spend.
 *
 * ── The lockdown that makes it safe to point at a user's message ──
 *
 * This call reads untrusted text, so it is built so that the worst a hostile
 * message can do is get itself classified wrong:
 *
 *  - EXACTLY ONE tool, and `tool_choice` forces it. The model cannot answer in
 *    prose, cannot call anything else, and there is nothing else to call.
 *  - The schema is the contract: `{ tier, reason }` and nothing more. A tier
 *    outside the three is discarded by the server, not trusted.
 *  - No history, no trip data beyond the trip's own name and leg names, no
 *    tools that touch the database. A successful injection wins a `T1`, which
 *    is what a plain "plan my trip" wins anyway.
 *  - `max_tokens: 60`. There is no room for the model to be talked into an
 *    essay, and no reason to pay for one.
 *
 * ── Biased to allow ──
 *
 * "When unsure, T1." A false T3 refuses a real driver mid-trip, which is the
 * expensive mistake; a false T1 costs $0.085 and reaches Penny, who is
 * perfectly capable of saying she cannot help. The breakers above bound how
 * many of those there can be.
 */

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = anthropicApiKey();
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

/** Interactive path — better to let a message through than to hang on it. */
const CLASSIFY_TIMEOUT_MS = 5000;

export interface ClassifyResult extends GateDecision {
  /** What the call cost, for the measurement. Zero when it did not run. */
  microcents: number;
}

/**
 * Classify one message.
 *
 * FAILS OPEN, to T1, on every failure path — no key, a timeout, a thrown SDK
 * error, a malformed tool result. This is the deliberate opposite of the
 * circuit breakers, and the asymmetry is the reason: a breaker failing open is
 * an attack window, while this failing CLOSED would refuse real drivers because
 * Anthropic had a bad minute, and everything expensive downstream is still
 * behind the breakers, the IP limits and the per-account caps. The gate is an
 * optimisation with teeth, not a security boundary.
 */
export async function classifyMessage(
  message: string,
  ctx: ClassifyContext = {},
  userId?: string,
  tripId?: string | null
): Promise<ClassifyResult> {
  const client = getClient();
  if (!client) {
    return { tier: 'T1', by: 'error', reason: 'no api key', microcents: 0 };
  }

  try {
    const res = await client.messages.create(
      {
        model: CLASSIFY_MODEL,
        max_tokens: CLASSIFY_MAX_TOKENS,
        system: CLASSIFY_SYSTEM,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'classify_message' },
        messages: [{ role: 'user', content: buildClassifyContent(message, ctx) }],
      },
      { timeout: CLASSIFY_TIMEOUT_MS }
    );

    const microcents = await recordCost(res, userId, tripId);

    const block = res.content.find((c) => c.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      return { tier: 'T1', by: 'error', reason: 'no tool call', microcents };
    }
    const parsed = readClassifyResult(block.input);
    if (!parsed) {
      return { tier: 'T1', by: 'error', reason: 'bad tier', microcents };
    }
    return { tier: parsed.tier, by: 'classifier', reason: parsed.reason, microcents };
  } catch (err) {
    console.error('[pennyClassifier] classify failed; allowing the message', err);
    return { tier: 'T1', by: 'error', reason: 'classifier failed', microcents: 0 };
  }
}

/**
 * Log what the call cost. Its own row, with its own model, because the whole
 * argument for the classifier is its price and an unmeasured price is a claim.
 */
async function recordCost(
  res: Anthropic.Message,
  userId?: string,
  tripId?: string | null
): Promise<number> {
  const u = res.usage;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;

  // Returned to the caller as well as written, because the whole argument for
  // having a classifier is its price, and an unmeasured price is a claim.
  const microcents = dollarsToMicrocents(
    estimateAnthropicCostUsd(CLASSIFY_MODEL, inputTokens, outputTokens, cacheCreate, cacheRead)
  );

  if (userId) {
    await logAnthropicUsageWithFallback({
      userId,
      tripId: tripId ?? null,
      model: CLASSIFY_MODEL,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheCreate,
      cacheReadInputTokens: cacheRead,
    });
  }
  return microcents;
}
