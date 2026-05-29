import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const SUBMIT_IDEA = 'submit_idea' as const;

const baseSchema = z.object({
  /** The user's suggestion, in their own words (summarized is fine). */
  idea: z.string().min(1, 'idea is required').max(1000),
  /** Optional short area tag, e.g. "fuel", "maps", "weather". */
  area: z.string().max(60).nullish(),
});

export type SubmitIdeaInput = z.infer<typeof baseSchema>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: SUBMIT_IDEA,
  description: `Log a user's feature idea / request for the team to read later. Call this when the user asks for something the app CAN'T do yet but that's a reasonable trip-planning capability — e.g. "find me the cheapest gas", "show fuel prices", "book this campsite", "show live traffic". Do NOT pretend you did the thing; log the idea instead, then tell the user one short sentence: "That's a good idea — I've passed it to the team."

Only call this for genuine, on-topic product ideas. For off-topic requests (jokes, general knowledge, other apps), do NOT call this — just redirect per your scope rules ("I only plan this trip…"). Never claim you submitted an idea without actually calling this tool.`,
  input_schema: {
    type: 'object',
    required: ['idea'],
    properties: {
      idea: {
        type: 'string',
        description: "The user's suggestion in plain language, e.g. \"wants to see live fuel prices to pick the cheapest station\".",
      },
      area: {
        type: 'string',
        description: 'Optional short tag for the area, e.g. "fuel", "maps", "weather", "booking".',
      },
    },
  },
};
