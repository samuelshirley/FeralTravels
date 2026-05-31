import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { latSchema, lngSchema } from './shared';

/**
 * plan_overnight_stop — find real, ranked overnight parking candidates near
 * where a day's drive ends. The server fetches the route polyline (Google
 * Directions), walks it to the target distance, queries OpenStreetMap for
 * parking/parks/caravan sites in that window, and ranks them deterministically
 * (the engine lives in src/lib/penny/overnight/). This tool does NOT write to
 * the DB — Penny presents the shortlist to the user, who picks.
 *
 * Why it exists: the app had no notion of what makes a *good* place to park
 * overnight, so Penny once suggested a dog park with no parking lot. The ranker
 * keys on the real discriminator — an adjacent parking lot — so the result set
 * marks `has_adjacent_lot` and Penny is told to prefer those. See
 * docs/overnight-stop-feature-scope.md.
 */

export const PLAN_OVERNIGHT_STOP = 'plan_overnight_stop' as const;

const baseSchema = z.object({
  origin_lat: latSchema,
  origin_lng: lngSchema,
  destination_lat: latSchema,
  destination_lng: lngSchema,
  origin_name: z.string().nullish(),
  destination_name: z.string().nullish(),
  /**
   * How far into the drive (km) to look for a stop. Omit to anchor at the
   * day's end (the destination). Set it to search earlier on the route.
   */
  target_km: z.number().positive().max(100_000).nullish(),
  /** Routing avoid flags — only when the user explicitly asks. */
  avoid: z.array(z.enum(['tolls', 'highways', 'ferries'])).nullish(),
});

export type PlanOvernightStopInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: PLAN_OVERNIGHT_STOP,
  description:
    "Find real overnight parking candidates near where a day's drive ends. Pass the day's origin and destination (e.g. the start/end of a leg, or a get_route split point); the server gets the route, searches OpenStreetMap along the last stretch, and returns candidates ranked best-first. Each candidate includes lat/lng, a maps_url, and has_adjacent_lot. PREFER candidates with has_adjacent_lot=true — a park or dog park with no parking lot is NOT somewhere to sleep. Present the top 1–3 with their maps_url so the user can eyeball the satellite view. NEVER invent overnight spots or claim a place is good if it isn't in this result set; if nothing has a lot, say so honestly. Optionally set target_km to search earlier in the drive instead of at the destination.",
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
      target_km: {
        type: 'number',
        minimum: 0,
        description:
          "How far into the drive (km) to look for a stop. Omit to anchor at the day's end. Set it to stop earlier than the destination.",
      },
      avoid: {
        type: 'array',
        items: { type: 'string', enum: ['tolls', 'highways', 'ferries'] },
        description: 'Routing avoid flags — only when the user explicitly asks.',
      },
    },
  },
};
