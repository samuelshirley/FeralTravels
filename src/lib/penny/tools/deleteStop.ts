import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const DELETE_STOP = 'delete_stop' as const;

const baseSchema = z.object({
  stop_id: z.string().uuid(),
});

export type DeleteStopInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: DELETE_STOP,
  description: 'Delete a stop by id.',
  input_schema: {
    type: 'object',
    required: ['stop_id'],
    properties: {
      stop_id: { type: 'string', format: 'uuid' },
    },
  },
};
