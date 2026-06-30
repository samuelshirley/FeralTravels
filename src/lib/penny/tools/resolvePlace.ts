import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

/**
 * resolve_place — turn a free-text place name, address, or city into
 * authoritative coordinates. This is the ONLY way Penny is allowed to obtain
 * lat/lng for a named location; she must never type coordinates from her own
 * knowledge (that produced the "dropped me near the right city but wrong spot"
 * bug). The server runs Google Places/Geocoding and hands back the resolved
 * point plus how exact it is, so Penny can either use it or ask the user to
 * sharpen a too-vague match.
 *
 * Lookup tool — like get_route, it does NOT write to the DB. Penny feeds the
 * returned lat/lng into get_route / add_leg / add_stop / update_leg.
 */

export const RESOLVE_PLACE = 'resolve_place' as const;

const baseSchema = z.object({
  /** What the user called the place: "Bergen", "Clean Kokos laundromat Bergen", a street address. */
  query: z.string().min(1).max(300),
  /**
   * Two-letter country code to bias the search (e.g. "no" for Norway) when you
   * know the country from trip context. Optional but improves accuracy for
   * bare names.
   */
  region: z.string().length(2).nullish(),
});

export type ResolvePlaceInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: RESOLVE_PLACE,
  description:
    'Resolve a place name, business, or address to authoritative coordinates via Google. Call this to get lat/lng for ANY named location before using it in get_route, add_leg, add_stop, or update_leg — origins, destinations, waypoints, and user-added stops alike. NEVER write coordinates from your own knowledge; always resolve them here. Returns a status: "resolved" (with lat/lng, a label, and a granularity of precise|locality|area|country), "ambiguous" (several distinct places match — show the user the candidates and ask which), "not_found" (no match — ask the user for a Maps link or to rephrase; do NOT invent a location), or "unavailable" (lookup is down — tell the user, do not guess). IMPORTANT: a "locality"/"area"/"country" granularity means you only got a city/region centroid. That is the right answer when the user named a city, but if the user named something specific (a business, campsite, address) and you got back only a centroid, treat it as too vague — tell them and ask them to sharpen it (paste a Maps link or give the street). Do not drop a pin in the middle of a city when the user wanted an exact place.',
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description:
          'The place as the user described it — a city ("Bergen"), a business ("Clean Kokos laundromat, Bergen"), or an address. Include the city/country when you know it; it sharpens the match.',
      },
      region: {
        type: 'string',
        description:
          'Optional 2-letter country code (e.g. "no", "us") to bias the search when you know the country from the trip.',
      },
    },
  },
};
