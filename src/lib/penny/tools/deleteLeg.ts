import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const DELETE_LEG = 'delete_leg' as const;

const baseSchema = z.object({
  leg_id: z.string().uuid(),
});

export type DeleteLegInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: DELETE_LEG,
  description: 'Delete a leg by id. Use when the user asks to remove a day or scrap a planned leg.',
  input_schema: {
    type: 'object',
    required: ['leg_id'],
    properties: {
      leg_id: { type: 'string', format: 'uuid' },
    },
  },
};
