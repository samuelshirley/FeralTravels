import { z } from 'zod';

/**
 * The adapter between a System One response and a decision we will act on.
 *
 * Deliberately narrow in what it TRUSTS and loose in what it TOLERATES:
 *
 *  - Extra fields anywhere are ignored. Backends add their own (`confidence`,
 *    `answer_confidence`, `action`, `routing`) and none of them are ours.
 *  - The backend's `confidence` is never read. On Laya it is uncalibrated —
 *    0.03–0.17 on answers that were right — so the only numbers we use are
 *    OUR reading of `probabilities`: the top one, and top minus second.
 *  - The echoed `model` is returned for the log and never compared with what
 *    was asked for; servers route and rename.
 *
 * And it REJECTS — which sends the message to Haiku — when the answer is not a
 * `choice`, names a label outside our enum, carries a probability for a label
 * we never offered, or picks a label that is not the most probable one. A
 * backend whose choice and probabilities disagree has told us two things, and
 * we do not get to pick the one we like.
 */

const probability = z.number().finite().min(0).max(1);

const choiceAnswer = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
  })
  .passthrough();

const tokenCount = z.number().int().nonnegative();

export const systemOneResponse = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), z.unknown()),
    usage: z
      .object({ input_tokens: tokenCount.optional(), output_tokens: tokenCount.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * The echoed model, only if it LOOKS like a model id. It is written to
 * `usage_events`, and a backend that echoed the driver's message back in that
 * field must not get the message into the ledger.
 */
function modelId(v: string | undefined): string | null {
  return v !== undefined && /^[A-Za-z0-9._:/@+-]{1,80}$/.test(v) ? v : null;
}

export interface ChoiceReading<L extends string> {
  choice: L;
  /** Our reading: the chosen label's probability. */
  top: number;
  /** Our reading: top minus the next most probable label (0 when tied). */
  margin: number;
  echoedModel: string | null;
  inputTokens: number;
  outputTokens: number;
}

export type ChoiceParse<L extends string> =
  | { ok: true; reading: ChoiceReading<L> }
  | { ok: false; reason: string; echoedModel: string | null; inputTokens: number; outputTokens: number };

/**
 * Read one `choice` answer out of a response body.
 *
 * Generic over the question key and the label set so the captured Laya
 * fixture (`place_intent`) and our own `tier` question go through the same
 * code — the fixture tests the adapter, not a copy of it.
 */
export function readChoiceAnswer<L extends string>(
  body: unknown,
  key: string,
  labels: readonly L[]
): ChoiceParse<L> {
  const parsed = systemOneResponse.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'response shape', echoedModel: null, inputTokens: 0, outputTokens: 0 };
  }
  const res = parsed.data;
  const echoedModel = modelId(res.model);
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;
  const fail = (reason: string): ChoiceParse<L> => ({
    ok: false,
    reason,
    echoedModel,
    inputTokens,
    outputTokens,
  });

  const answer = choiceAnswer.safeParse(res.answers[key]);
  if (!answer.success) return fail('answer shape');

  const { choice, probabilities } = answer.data;
  const allowed = new Set<string>(labels);
  if (!allowed.has(choice)) return fail('choice outside enum');
  for (const label of Object.keys(probabilities)) {
    if (!allowed.has(label)) return fail('probability outside enum');
  }
  if (!(choice in probabilities)) return fail('no probability for choice');

  const top = probabilities[choice];
  let second = 0;
  for (const label of labels) {
    if (label === choice) continue;
    const p = probabilities[label] ?? 0;
    if (p > top) return fail('choice is not the most probable');
    if (p > second) second = p;
  }

  return {
    ok: true,
    reading: {
      choice: choice as L,
      top,
      margin: top - second,
      echoedModel,
      inputTokens,
      outputTokens,
    },
  };
}
