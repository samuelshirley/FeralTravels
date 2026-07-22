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
  urlSchema,
} from './shared';

export const UPDATE_STOP = 'update_stop' as const;

/**
 * Penny may update an existing fuel stop's status/coords/name (e.g. the user
 * selects one of Finn's options), but she may NOT *convert* a stop into a fuel
 * stop — minting fuel rows is Finn's job alone (see addStop.ts). So the only
 * settable stop_type here is 'other'; to touch a fuel stop she omits stop_type
 * and updates other fields.
 */
const settableStopTypeSchema = z.literal('other');

const dataSchema = z.object({
  stop_type: settableStopTypeSchema.nullish(),
  name: z.string().min(1).nullish(),
  lat: latSchema.nullish(),
  lng: lngSchema.nullish(),
  distance_from_start_km: z.number().nonnegative().nullish(),
  notes: z.string().nullish(),
  status: stopStatusSchema.nullish(),
  fuel_type: fuelTypeSchema.nullish(),
  fuel_amount_l: z.number().positive().nullish(),
  source: stopSourceSchema.nullish(),
  source_url: urlSchema.nullish(),
});

const baseSchema = z.object({
  stop_id: z.string().uuid(),
  data: dataSchema,
});

export type UpdateStopInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: UPDATE_STOP,
  description:
    'Update a stop by id — common uses: change status to "selected"/"dismissed" when the user picks among options, or fix a stop\'s coords/name.',
  input_schema: {
    type: 'object',
    required: ['stop_id', 'data'],
    properties: {
      stop_id: { type: 'string', format: 'uuid' },
      data: {
        type: 'object',
        properties: {
          stop_type: {
            type: 'string',
            enum: ['other'],
            description: 'Only "other" is settable. Omit to update a fuel stop without changing its type.',
          },
          name: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          distance_from_start_km: { type: 'number', minimum: 0 },
          notes: { type: 'string' },
          status: { type: 'string', enum: ['option', 'selected', 'dismissed'] },
          fuel_type: { type: 'string', enum: ['diesel', 'petrol', 'premium', 'lpg'] },
          fuel_amount_l: { type: 'number', minimum: 0 },
          source: { type: 'string', enum: ['penny', 'user', 'google_places', 'google', 'manual'] },
          source_url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};
