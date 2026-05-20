import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const RENAME_TRIP = 'rename_trip' as const;

const baseSchema = z.object({
  name: z
    .string()
    .min(1, 'Trip name cannot be empty')
    .max(200, 'Trip name is too long (max 200 characters)'),
});

export type RenameTripInput = z.infer<typeof baseSchema>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: RENAME_TRIP,
  description: `
Rename the current trip. Call this when the user tells you what they'd like to name their trip.
The name should be short and descriptive — e.g. "Spain to Gorafe", "Nordic Adventure", "Morocco Coast Run".
`.trim(),
  input_schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'The new name for the trip.',
      },
    },
  },
};
