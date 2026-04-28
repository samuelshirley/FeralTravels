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

export const ADD_ROUTE = 'add_route' as const;

const dataSchema = z
  .object({
    label: z.string().min(1, 'label is required'),
    description: z.string().nullish(),
    distance_km: distanceKmSchema.nullish(),
    surface: surfaceSchema.nullish(),
    status: routeStatusSchema.nullish(),
    gpx_trail_id: z.number().int().nullish(),
    end_lat: latSchema.nullish(),
    end_lng: lngSchema.nullish(),
    end_name: z.string().nullish(),
    end_source: z.enum(['google_places', 'manual']).nullish(),
    end_source_url: urlSchema.nullish(),
    drive_time_minutes: driveTimeMinutesSchema.nullish(),
    links: z.array(routeLinkSchema).nullish(),
  })
  .refine(
    (d) => (d.end_lat == null) === (d.end_lng == null),
    {
      message: 'end_lat and end_lng must both be set or both omitted.',
      path: ['end_lat'],
    }
  );

const baseSchema = z.object({
  leg_id: z.number().int().positive(),
  data: dataSchema,
});

export type AddRouteInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: ADD_ROUTE,
  description:
    'Add a route option to a leg (e.g. Route A / Route B / overnight option). Multi-route legs let the user pick — default new routes to status="option".',
  input_schema: {
    type: 'object',
    required: ['leg_id', 'data'],
    properties: {
      leg_id: { type: 'integer' },
      data: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          distance_km: { type: 'number', minimum: 0 },
          surface: { type: 'string', enum: ['paved', 'gravel', 'mix'] },
          status: { type: 'string', enum: ['option', 'selected', 'dismissed'] },
          gpx_trail_id: { type: 'integer' },
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
            description:
              'For "google_maps" links, use https://www.google.com/maps/dir/?api=1&origin=LAT,LNG&destination=LAT,LNG&travelmode=driving&dir_action=navigate — never goo.gl short links or place preview URLs.',
          },
        },
      },
    },
  },
};
