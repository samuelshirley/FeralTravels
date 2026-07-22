import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const PLAN_FUEL_STOPS = 'plan_fuel_stops' as const;

const baseSchema = z.object({
  leg_id: z.string().uuid(),
});

export type PlanFuelStopsInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: PLAN_FUEL_STOPS,
  description:
    'Auto-place fuel stops along a leg at intervals matching the vehicle\'s effective_range_km (Google route geometry + Google Places gas_station search along the route). Prefer this over inventing fuel add_stop rows when you need real stations with lat/lng. The server inserts optional fuel stops on the leg — it does not emit add_stop tool calls for you.',
  input_schema: {
    type: 'object',
    required: ['leg_id'],
    properties: {
      leg_id: {
        type: 'string',
        format: 'uuid',
        description:
          'Persisted legs[].id (UUID) from context for this leg (same id you passed to add_leg or that already exists — not sort_order, not ordinal).',
      },
    },
  },
};
