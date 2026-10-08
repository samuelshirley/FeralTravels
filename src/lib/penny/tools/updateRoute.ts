import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  distanceKmJson,
  distanceKmSchema,
  driveTimeMinutesJson,
  driveTimeMinutesSchema,
  latSchema,
  lngSchema,
  routeLinkSchema,
  routeStatusSchema,
  sourcedTextSchema,
  unsourcedFieldSchema,
  urlSchema,
} from './shared';

export const UPDATE_ROUTE = 'update_route' as const;

const dataSchema = z.object({
  label: z.string().min(1).nullish(),
  description: sourcedTextSchema('description').nullish(),
  distance_km: distanceKmSchema.nullish(),
  surface: unsourcedFieldSchema('surface'),
  status: routeStatusSchema.nullish(),
  end_lat: latSchema.nullish(),
  end_lng: lngSchema.nullish(),
  end_name: z.string().nullish(),
  end_source: z.enum(['google_places', 'manual']).nullish(),
  end_source_url: urlSchema.nullish(),
  drive_time_minutes: driveTimeMinutesSchema.nullish(),
  links: z.array(routeLinkSchema).nullish(),
})
  // Both or neither, as on add_route. A lone end_lat would be merged into the
  // row's old end_lng: a point that is nowhere either value came from.
  .refine((d) => (d.end_lat == null) === (d.end_lng == null), {
    message: 'end_lat and end_lng must both be set or both omitted.',
    path: ['end_lat'],
  });

const baseSchema = z.object({
  route_id: z.string().uuid(),
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
      route_id: { type: 'string', format: 'uuid' },
      data: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          distance_km: distanceKmJson,
          status: { type: 'string', enum: ['option', 'selected', 'dismissed'] },
          end_lat: { type: 'number', minimum: -90, maximum: 90 },
          end_lng: { type: 'number', minimum: -180, maximum: 180 },
          end_name: { type: 'string' },
          end_source: { type: 'string', enum: ['google_places', 'manual'] },
          end_source_url: { type: 'string', format: 'uri' },
          drive_time_minutes: driveTimeMinutesJson,
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
