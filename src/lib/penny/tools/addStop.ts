import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { distanceToSegmentKm } from '@/lib/penny/geo';
import {
  fuelTypeSchema,
  latSchema,
  lngSchema,
  stopSourceSchema,
  stopStatusSchema,
  stopTypeSchema,
  urlSchema,
} from './shared';

export const ADD_STOP = 'add_stop' as const;

const dataSchema = z
  .object({
    stop_type: stopTypeSchema,
    name: z.string().min(1, 'name is required'),
    lat: latSchema.nullish(),
    lng: lngSchema.nullish(),
    distance_from_start_km: z.number().nonnegative().nullish(),
    notes: z.string().nullish(),
    status: stopStatusSchema.nullish(),
    fuel_type: fuelTypeSchema.nullish(),
    fuel_amount_l: z.number().positive().nullish(),
    source: stopSourceSchema.nullish(),
    source_url: urlSchema.nullish(),
  })
  .refine(
    (d) => d.stop_type !== 'fuel' || d.fuel_type != null,
    {
      message: 'fuel_type is required when stop_type is "fuel".',
      path: ['fuel_type'],
    }
  );

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
 * Cross-leg validator:
 * 1. distance_from_start_km must be ≤ leg.distance_km
 * 2. stop lat/lng must be within a reasonable corridor of the assigned leg
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
  });
}

export const tool: Anthropic.Tool = {
  name: ADD_STOP,
  description:
    'Add a stop along a leg. Two stop types: "fuel" (gas stop) and "other" (any place the user explicitly wants to visit or route through — a Google Maps link, address, place name, landmark, bridge, pass, viewpoint, or detour). Default status is "option" unless the user explicitly picks it. For fuel stops, fuel_type is required. Use stop_type="other" with status="selected" to force the route through a place — these become &waypoints= in the leg\'s Google Maps URL. Always provide lat/lng plus a best-effort distance_from_start_km so waypoints sort correctly along the driving direction.',
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
            enum: ['fuel', 'other'],
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
          fuel_type: {
            type: 'string',
            enum: ['diesel', 'petrol', 'premium', 'lpg'],
            description: 'Required when stop_type is "fuel".',
          },
          fuel_amount_l: { type: 'number', minimum: 0 },
          source: {
            type: 'string',
            enum: ['penny', 'user', 'google_places', 'osm', 'manual'],
            description: 'Default to "penny" when you invent a placeholder so the UI knows to mark it for verification.',
          },
          source_url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};
