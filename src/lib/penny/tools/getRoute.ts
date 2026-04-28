import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { latSchema, lngSchema } from './shared';

/**
 * get_route — call this BEFORE add_leg whenever you need authoritative
 * distance / drive_time / polyline for a new driving day. The server runs
 * Google Directions and (if the trip exceeds the per-day cap) returns a
 * suggested split with real lat/lng points along the route.
 *
 * This tool's output is consumed only by Penny — it does not write to the
 * database. The actual write happens via add_leg(s) Penny emits next.
 */

export const GET_ROUTE = 'get_route' as const;

const baseSchema = z.object({
  origin_lat: latSchema,
  origin_lng: lngSchema,
  destination_lat: latSchema,
  destination_lng: lngSchema,
  origin_name: z.string().nullish(),
  destination_name: z.string().nullish(),
  /**
   * Things to route around. Mostly leave empty — this is a road-trip app
   * and most users don't pre-emptively avoid highways or tolls. Set only
   * when the user explicitly says.
   */
  avoid: z.array(z.enum(['tolls', 'highways', 'ferries'])).nullish(),
});

export type GetRouteInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: GET_ROUTE,
  description:
    'Get the real driving route between two points from Google Directions. Returns total distance_km, drive_time_minutes, and the polyline. If drive_time_minutes exceeds the vehicle\'s daily driving cap, also returns a suggested per-day split with real lat/lng points along the route — use those split points as start/end for one add_leg per day. ALWAYS call this before add_leg for new multi-day plans; never invent distance or drive time from your own knowledge.',
  input_schema: {
    type: 'object',
    required: ['origin_lat', 'origin_lng', 'destination_lat', 'destination_lng'],
    properties: {
      origin_lat: { type: 'number', minimum: -90, maximum: 90 },
      origin_lng: { type: 'number', minimum: -180, maximum: 180 },
      destination_lat: { type: 'number', minimum: -90, maximum: 90 },
      destination_lng: { type: 'number', minimum: -180, maximum: 180 },
      origin_name: { type: 'string', description: 'Optional human-readable name for logging.' },
      destination_name: { type: 'string', description: 'Optional human-readable name for logging.' },
      avoid: {
        type: 'array',
        items: { type: 'string', enum: ['tolls', 'highways', 'ferries'] },
        description: 'Only set when user explicitly asks to avoid these.',
      },
    },
  },
};
