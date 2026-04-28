import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
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
  leg_id: z.number().int().positive(),
  data: dataSchema,
});

export type AddStopInput = z.infer<typeof baseSchema>;

/**
 * Cross-leg validator: distance_from_start_km must be ≤ leg.distance_km.
 * Reads the leg from PennyContext.legs.
 */
export function validator(ctx: PennyContext) {
  return baseSchema.superRefine((input, refCtx) => {
    if (input.data.distance_from_start_km == null) return;
    const leg = ctx.legs.find((l) => l.id === input.leg_id);
    if (leg?.distance_km != null && input.data.distance_from_start_km > leg.distance_km) {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data', 'distance_from_start_km'],
        message: `distance_from_start_km (${input.data.distance_from_start_km}) exceeds leg.distance_km (${leg.distance_km}).`,
      });
    }
  });
}

export const tool: Anthropic.Tool = {
  name: ADD_STOP,
  description:
    'Add a stop along a leg — fuel, water, food, overnight, rest, or other. Default status is "option" unless the user explicitly picks this stop. For fuel stops, fuel_type is required.',
  input_schema: {
    type: 'object',
    required: ['leg_id', 'data'],
    properties: {
      leg_id: { type: 'integer' },
      data: {
        type: 'object',
        required: ['stop_type', 'name'],
        properties: {
          stop_type: {
            type: 'string',
            enum: ['fuel', 'water', 'food', 'overnight', 'rest', 'other'],
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
