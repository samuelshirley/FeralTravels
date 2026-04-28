import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  distanceKmSchema,
  driveTimeMinutesSchema,
  latSchema,
  lngSchema,
  routeLinkSchema,
  routeStatusSchema,
  surfaceSchema,
  urlSchema,
} from './shared';

export const UPDATE_ROUTE = 'update_route' as const;

const dataSchema = z.object({
  label: z.string().min(1).nullish(),
  description: z.string().nullish(),
  distance_km: distanceKmSchema.nullish(),
  surface: surfaceSchema.nullish(),
  status: routeStatusSchema.nullish(),
  end_lat: latSchema.nullish(),
  end_lng: lngSchema.nullish(),
  end_name: z.string().nullish(),
  end_source: z.enum(['google_places', 'manual']).nullish(),
  end_source_url: urlSchema.nullish(),
  drive_time_minutes: driveTimeMinutesSchema.nullish(),
  links: z.array(routeLinkSchema).nullish(),
});

const baseSchema = z.object({
  route_id: z.number().int().positive(),
  data: dataSchema,
});

export type UpdateRouteInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: UPDATE_ROUTE,
  description:
    'Update a route by id — common uses: change status to "selected" when the user picks one, or amend description / links.',
  input_schema: {
    type: 'object',
    required: ['route_id', 'data'],
    properties: {
      route_id: { type: 'integer' },
      data: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          distance_km: { type: 'number', minimum: 0 },
          surface: { type: 'string', enum: ['paved', 'gravel', 'mix'] },
          status: { type: 'string', enum: ['option', 'selected', 'dismissed'] },
          end_lat: { type: 'number', minimum: -90, maximum: 90 },
          end_lng: { type: 'number', minimum: -180, maximum: 180 },
          end_name: { type: 'string' },
          end_source: { type: 'string', enum: ['google_places', 'manual'] },
          end_source_url: { type: 'string', format: 'uri' },
          drive_time_minutes: { type: 'integer', minimum: 0, maximum: 24 * 60 },
          links: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type', 'label', 'url'],
              properties: {
                type: {
                  type: 'string',
                  enum: ['gpx', 'google_maps', 'wikiloc', 'komoot', 'gaia', 'dog_park', 'park', 'other'],
                },
                label: { type: 'string' },
                url: { type: 'string', format: 'uri' },
              },
            },
          },
        },
      },
    },
  },
};
