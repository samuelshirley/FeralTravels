import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const PLAN_DUMP_STATION_STOPS = 'plan_dump_station_stops' as const;

const baseSchema = z.object({
  leg_id: z.string().uuid(),
  /**
   * Optional country code (ISO 3166-1 alpha-2) for the region where the
   * leg is located. Penny should provide this from the route context so
   * the search uses localized dump station terminology. Falls back to
   * English queries when absent.
   */
  country_code: z.string().length(2).nullish(),
});

export type PlanDumpStationStopsInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: PLAN_DUMP_STATION_STOPS,
  description:
    'Find and place a dump station stop on a leg. Uses Google Places Text Search to find RV / motorhome dump stations (which also provide fresh water fill) near the leg\'s end point. Only call this when the vehicle has dump_station_tracking_enabled and the user needs a dump station on this leg (based on dump_station_interval_days or explicit request). Provide country_code (e.g. "ES" for Spain, "FR" for France) for better localized results. The server inserts an optional dump_station stop on the leg.',
  input_schema: {
    type: 'object',
    required: ['leg_id'],
    properties: {
      leg_id: {
        type: 'string',
        format: 'uuid',
        description:
          'Persisted legs[].id (UUID) for the leg where the dump station stop should be placed.',
      },
      country_code: {
        type: 'string',
        minLength: 2,
        maxLength: 2,
        description:
          'ISO 3166-1 alpha-2 country code for the region (e.g. "ES", "FR", "DE"). Helps localize search terms for better results.',
      },
    },
  },
};
