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

/**
 * Google's opaque handle for a place, as `resolve_place` returned it.
 *
 * Bounded and never parsed: Penny forwards the string she was given and the
 * server puts it in the query as `place_id:<id>`. The length cap is the only
 * thing asserted about its shape — inventing a rule for Google's id format is
 * how a valid id starts getting rejected.
 */
const placeIdSchema = z.string().min(1).max(300);

const baseSchema = z.object({
  origin_lat: latSchema,
  origin_lng: lngSchema,
  destination_lat: latSchema,
  destination_lng: lngSchema,
  origin_name: z.string().nullish(),
  destination_name: z.string().nullish(),
  /**
   * The `place_id` resolve_place gave you for each end, when it gave you one.
   *
   * Not decoration. A large park's Places coordinate is its POLYGON centroid,
   * which can sit in roadless backcountry — Zion's does — and Directions
   * answers ZERO_RESULTS for it while the same place routes fine by id.
   */
  origin_place_id: placeIdSchema.nullish(),
  destination_place_id: placeIdSchema.nullish(),
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
        place_id: placeIdSchema.nullish(),
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
    'Get the real driving route between two points from Google Directions. Returns total distance_km, drive_time_minutes, and the polyline. If resolve_place gave you a place_id for either end, ALWAYS pass it as origin_place_id / destination_place_id — it routes to the place\'s real entrance, where a bare coordinate may be an unreachable centroid (a large national park\'s coordinate is the middle of its polygon, which can be roadless). The result also carries routable_start and routable_end: the points Directions actually snapped to. Use THOSE as add_leg\'s start_lat/lng and end_lat/lng, in preference to the coordinates you passed in. Pass `avoid` only when the user explicitly asks to skip tolls/highways/ferries. This is NOT gravel-only routing: Directions still favors paved roads. If drive_time_minutes exceeds the vehicle\'s daily driving cap, also returns a suggested per-day split with real lat/lng points along the route — use those split points as start/end for one add_leg per day. ALWAYS call this before add_leg for new multi-day plans; never invent distance or drive time from your own knowledge.',
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
      origin_place_id: {
        type: 'string',
        description:
          "The place_id resolve_place returned for the origin. Pass it whenever you have one — it routes to the place's real entrance rather than to a coordinate that may be unreachable. Forward it exactly as given; never write or edit one yourself.",
      },
      destination_place_id: {
        type: 'string',
        description:
          "The place_id resolve_place returned for the destination. Pass it whenever you have one — it routes to the place's real entrance rather than to a coordinate that may be unreachable. Forward it exactly as given; never write or edit one yourself.",
      },
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
            place_id: {
              type: 'string',
              description: "The waypoint's place_id from resolve_place, when you have one.",
            },
          },
        },
      },
    },
  },
};
