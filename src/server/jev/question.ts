import { z } from 'zod';

import type { MessageTier } from '@/lib/pennyGate';
import {
  buildClassifyContent,
  CLASSIFY_SYSTEM,
  CLASSIFY_TOOL,
  type ClassifyContext,
} from '@/lib/pennyClassifierPrompt';

/**
 * The tier question, built from the SAME source Haiku's request is built from.
 *
 * `pennyClassifierPrompt.ts` owns the wording: the system prompt becomes
 * `instructions`, `buildClassifyContent()` becomes `state`, and the three
 * `criteria` are cut out of the tool's own `tier` description (`T1 = … T2 = …
 * T3 = …`). Nothing here is a second copy of the prompt, so the two
 * classifiers are asked the same question by construction — and an edit to
 * the Haiku prompt that breaks the `Tn =` layout fails `jevAdapter.test.ts`
 * rather than quietly sending Jev an empty criterion.
 *
 * The enum is read from the tool schema too, and checked to be exactly the
 * three tiers — a fourth tier added there must be a decision here as well.
 */

export const TIER_QUESTION_KEY = 'tier';
export const TIER_LABELS: readonly MessageTier[] = ['T1', 'T2', 'T3'];

const tierProperty = z.object({
  tier: z.object({ enum: z.array(z.string()), description: z.string() }),
});

/** Split `T1 = a. T2 = b. T3 = c. WHEN UNSURE…` into the three criteria. */
export function tierCriteria(): Record<MessageTier, string> {
  const { tier } = tierProperty.parse(CLASSIFY_TOOL.input_schema.properties);
  if (tier.enum.join(',') !== TIER_LABELS.join(',')) {
    throw new Error(`classifier enum is ${tier.enum.join(',')}, Jev asks ${TIER_LABELS.join(',')}`);
  }
  const parts = tier.description.split(/\b(T[123]) = /);
  // ['', 'T1', text, 'T2', text, 'T3', text]
  const out: Partial<Record<MessageTier, string>> = {};
  for (let i = 1; i + 1 < parts.length; i += 2) {
    out[parts[i] as MessageTier] = parts[i + 1].trim();
  }
  for (const label of TIER_LABELS) {
    if (!out[label]) throw new Error(`no criterion for ${label} in the classifier description`);
  }
  return out as Record<MessageTier, string>;
}

export interface SystemOneRequest {
  model: string;
  state: string;
  questions: Record<
    string,
    { type: 'choice'; instructions: string; criteria: Record<string, string> }
  >;
}

export function buildTierRequest(
  message: string,
  ctx: ClassifyContext,
  model: string
): SystemOneRequest {
  return {
    model,
    state: buildClassifyContent(message, ctx),
    questions: {
      [TIER_QUESTION_KEY]: {
        type: 'choice',
        instructions: CLASSIFY_SYSTEM,
        criteria: tierCriteria(),
      },
    },
  };
}
