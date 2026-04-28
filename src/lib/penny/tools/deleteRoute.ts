import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const DELETE_ROUTE = 'delete_route' as const;

const baseSchema = z.object({
  route_id: z.number().int().positive(),
});

export type DeleteRouteInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: DELETE_ROUTE,
  description: 'Delete a route by id.',
  input_schema: {
    type: 'object',
    required: ['route_id'],
    properties: {
      route_id: { type: 'integer' },
    },
  },
};
