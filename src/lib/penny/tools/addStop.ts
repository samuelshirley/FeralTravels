import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { distanceToSegmentKm, haversineKm } from '@/lib/penny/geo';
import {
  latSchema,
  lngSchema,
  stopSourceSchema,
  stopStatusSchema,
  urlSchema,
} from './shared';

export const ADD_STOP = 'add_stop' as const;

/**
 * Penny only ever AUTHORS one kind of stop: 'other' — a place the user
 * explicitly named or linked. Fuel stops are NOT created here; they come
 * exclusively from Finn (the `plan_fuel_stops` tool) or the server-side
 * lazy day-open loader, both of which attach a real, located station with
 * coordinates. Allowing `add_stop` to mint a 'fuel' row let Penny persist a
 * coordinate-less placeholder ("Fuel stop — Aurdal (departure)", 0 km) that
 * points at no actual station — an empty stop that does nothing. The fix is
 * structural: Penny cannot type 'fuel' here at all, so that state is
 * unreachable. See <fuel_planning_rules> in src/lib/claude.ts.
 */
const addStopTypeSchema = z.literal('other');

const dataSchema = z.object({
  stop_type: addStopTypeSchema,
  name: z.string().min(1, 'name is required'),
  lat: latSchema.nullish(),
  lng: lngSchema.nullish(),
  distance_from_start_km: z.number().nonnegative().nullish(),
  notes: z.string().nullish(),
  status: stopStatusSchema.nullish(),
  source: stopSourceSchema.nullish(),
  source_url: urlSchema.nullish(),
});

const baseSchema = z.object({
  leg_id: z.string().uuid(),
  data: dataSchema,
});

export type AddStopInput = z.infer<typeof baseSchema>;

/**
 * Maximum detour distance (km) a stop can be from the leg's start↔end corridor.
 *
 * This is the straight-line distance from the stop to the nearest point on the
 * straight line between the leg's start and end. 200 km is generous enough for
 * scenic detours (the Millau Bridge is ~100 km off the Girona→Lyon straight
 * line) while still catching obviously wrong legs (Millau Bridge is ~700 km
 * from the Würzburg→Berlin corridor).
 */
const MAX_STOP_CORRIDOR_DEVIATION_KM = 200;

/**
 * A stop this close to the leg's END coords is a duplicate of the destination.
 *
 * The UI auto-generates a "Route to Destination" navigation button for every
 * leg from its end coords (buildSegmentedNavUrls in lib/maps.ts) — the
 * destination NEVER needs a stop row to be navigable. The real incident this
 * guards (trip d0b5741b, 2026-07-12): the user couldn't see the destination
 * button (mobile smart-nav collapses to the single next stop), told Penny "I
 * don't have the link to the end point", and Penny compensated by adding an
 * 'other' stop at exactly the leg-end coords — producing THREE nav buttons on
 * desktop, two of them to the same place. Display complaints must never be
 * answered with data writes; see <app_ui_awareness> in src/lib/claude.ts.
 */
const DUPLICATE_DESTINATION_RADIUS_KM = 1;

/** Instructive rejection Penny sees in-loop, so she self-corrects this turn. */
export function duplicateDestinationRejectionMessage(name: string, legTitle: string | null) {
  return (
    `Stop "${name}" is at the ${legTitle ?? 'assigned leg'}'s destination coords. ` +
    `Do not add the destination as a stop — every leg already gets an automatic ` +
    `"Route to Destination" navigation button built from its end coords, so this ` +
    `would create a duplicate button to the same place. If the user can't see the ` +
    `destination button, explain the navigation UI instead of editing the plan ` +
    `(see <app_ui_awareness>). If they want to END the day somewhere else, that is ` +
    `an update_leg destination change, not a stop.`
  );
}

/**
 * Cross-leg validator:
 * 1. distance_from_start_km must be ≤ leg.distance_km
 * 2. stop lat/lng must be within a reasonable corridor of the assigned leg
 * 3. stop must not duplicate the leg's destination (see above)
 */
export function validator(ctx: PennyContext) {
  return baseSchema.superRefine((input, refCtx) => {
    const leg = ctx.legs.find((l) => l.id === input.leg_id);

    // Distance-from-start check (existing).
    if (
      input.data.distance_from_start_km != null &&
      leg?.distance_km != null &&
      input.data.distance_from_start_km > leg.distance_km
    ) {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data', 'distance_from_start_km'],
        message: `distance_from_start_km (${input.data.distance_from_start_km}) exceeds leg.distance_km (${leg.distance_km}).`,
      });
    }

    // Geographic proximity check: stop must be near the leg's corridor.
    if (
      input.data.lat != null &&
      input.data.lng != null &&
      leg?.start_lat != null &&
      leg?.start_lng != null &&
      leg?.end_lat != null &&
      leg?.end_lng != null
    ) {
      const deviationKm = distanceToSegmentKm(
        input.data.lat,
        input.data.lng,
        leg.start_lat,
        leg.start_lng,
        leg.end_lat,
        leg.end_lng
      );
      if (deviationKm > MAX_STOP_CORRIDOR_DEVIATION_KM) {
        refCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'lat'],
          message: `Stop "${input.data.name}" is ~${Math.round(deviationKm)} km from the ${leg.title ?? 'assigned leg'} corridor (max ${MAX_STOP_CORRIDOR_DEVIATION_KM} km). Check leg_id — this stop likely belongs on a different leg.`,
        });
      }
    }

    // Duplicate-destination check: a stop at the leg's end coords duplicates
    // the destination's automatic nav button (see constant docs above).
    if (
      input.data.lat != null &&
      input.data.lng != null &&
      leg?.end_lat != null &&
      leg?.end_lng != null
    ) {
      const distToEndKm = haversineKm(
        input.data.lat,
        input.data.lng,
        leg.end_lat,
        leg.end_lng
      );
      if (distToEndKm <= DUPLICATE_DESTINATION_RADIUS_KM) {
        refCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'lat'],
          message: duplicateDestinationRejectionMessage(input.data.name, leg.title ?? null),
        });
      }
    }
  });
}

export const tool: Anthropic.Tool = {
  name: ADD_STOP,
  description:
    'Add a user-named place to a leg. stop_type is ALWAYS "other": a place the user explicitly wants to visit or route through — a Google Maps link, address, place name, landmark, bridge, pass, viewpoint, or detour. This is the ONLY kind of stop you create. Do NOT use this for fuel — fuel stops are found by Finn via plan_fuel_stops, never authored by hand (a hand-made fuel stop has no real station behind it). NEVER add a stop at the leg\'s destination coords — the destination automatically gets its own "Route to Destination" navigation button, so that stop would be a duplicate (rejected within ~1 km of the leg end). Default status is "option" unless the user explicitly picks it. Use status="selected" to force the route through a place — these become &waypoints= in the leg\'s Google Maps URL. Always provide lat/lng plus a best-effort distance_from_start_km so waypoints sort correctly along the driving direction.',
  input_schema: {
    type: 'object',
    required: ['leg_id', 'data'],
    properties: {
      leg_id: { type: 'string', format: 'uuid' },
      data: {
        type: 'object',
        required: ['stop_type', 'name'],
        properties: {
          stop_type: {
            type: 'string',
            enum: ['other'],
            description: 'Always "other". Fuel stops come from plan_fuel_stops, not this tool.',
          },
          name: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          distance_from_start_km: {
            type: 'number',
            minimum: 0,
            description: 'Distance from leg start, kilometres. Must be ≤ leg.distance_km.',
          },
          notes: { type: 'string' },
          status: { type: 'string', enum: ['option', 'selected', 'dismissed'] },
          source: {
            type: 'string',
            enum: ['penny', 'user', 'google_places', 'osm', 'manual'],
            description: 'Use "user" for a place the user named/linked; "penny" only for a verify-me placeholder.',
          },
          source_url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};
