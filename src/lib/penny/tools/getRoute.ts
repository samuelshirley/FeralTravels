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
  /** Things to route around — only add when the user explicitly asks. */
  avoid: z.array(z.enum(['tolls', 'highways', 'ferries'])).nullish(),
  /**
   * Ordered pass-through points the drive must cross WITHOUT stopping overnight
   * (e.g. "drive over the Millau bridge on the way"). The returned distance /
   * drive time / polyline include the detour. Use this instead of turning a
   * drive-through into its own stop or extra day.
   */
  waypoints: z
    .array(
      z.object({
        lat: latSchema,
        lng: lngSchema,
        name: z.string().nullish(),
      }),
    )
    .max(25)
    .nullish(),
});

export type GetRouteInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: GET_ROUTE,
  description:
    'Get the real driving route between two points from Google Directions. Returns total distance_km, drive_time_minutes, and the polyline. Pass `avoid` only when the user explicitly asks to skip tolls/highways/ferries. This is NOT gravel-only routing: Directions still favors paved roads. If drive_time_minutes exceeds the vehicle\'s daily driving cap, also returns a suggested per-day split with real lat/lng points along the route — use those split points as start/end for one add_leg per day. ALWAYS call this before add_leg for new multi-day plans; never invent distance or drive time from your own knowledge.',
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
        description:
          'Avoid flags — only add when the user explicitly asks (e.g. "avoid tolls", "no highways").',
      },
      waypoints: {
        type: 'array',
        description:
          'Ordered pass-through points the drive crosses WITHOUT an overnight stop (e.g. "drive over the Millau bridge on the way to Innsbruck"). The returned distance/drive_time/polyline include the detour. Use this for any bridge/pass/viewpoint/landmark the user wants to traverse — do NOT make it a separate stop or extra driving day. List them in along-route order.',
        items: {
          type: 'object',
          required: ['lat', 'lng'],
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            name: { type: 'string', description: 'Optional human-readable name for logging.' },
          },
        },
      },
    },
  },
};
