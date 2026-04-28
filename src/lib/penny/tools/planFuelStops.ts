import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const PLAN_FUEL_STOPS = 'plan_fuel_stops' as const;

const baseSchema = z.object({
  leg_id: z.number().int().positive(),
});

export type PlanFuelStopsInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: PLAN_FUEL_STOPS,
  description:
    'Auto-place fuel stops along a leg at intervals matching the vehicle\'s effective_range_km. Use this when the leg distance exceeds the vehicle range and you don\'t want to invent specific stations. The server expands this into N add_stop inserts.',
  input_schema: {
    type: 'object',
    required: ['leg_id'],
    properties: {
      leg_id: { type: 'integer' },
    },
  },
};
