import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  distanceKmSchema,
  driveTimeMinutesSchema,
  latSchema,
  legStatusSchema,
  lngSchema,
  terrainSchema,
} from './shared';

export const UPDATE_LEG = 'update_leg' as const;

const dataSchema = z.object({
  title: z.string().min(1).nullish(),
  label: z.string().nullish(),
  start_name: z.string().nullish(),
  end_name: z.string().nullish(),
  start_lat: latSchema.nullish(),
  start_lng: lngSchema.nullish(),
  end_lat: latSchema.nullish(),
  end_lng: lngSchema.nullish(),
  dates: z.string().nullish(),
  distance_km: distanceKmSchema.nullish(),
  drive_time_minutes: driveTimeMinutesSchema.nullish(),
  terrain: terrainSchema.nullish(),
  overnight: z.string().nullish(),
  status: legStatusSchema.nullish(),
  color: z.string().nullish(),
  notes: z.array(z.string()).nullish(),
  // Re-tag a leg's group membership. Pass null for both to ungroup.
  // See addLeg for the grouping semantics.
  segment_index: z.number().int().min(0).nullish(),
  segment_name: z.string().min(1).max(200).nullish(),
  costs: z
    .array(
      z.object({
        item: z.string(),
        estimate: z.string(),
        is_total: z.boolean().optional(),
      })
    )
    .nullish(),
});

const baseSchema = z.object({
  leg_id: z.number().int().positive(),
  data: dataSchema,
});

export type UpdateLegInput = z.infer<typeof baseSchema>;

export function validator(ctx: PennyContext) {
  return baseSchema.refine(
    (input) => {
      const cap = ctx.vehicle?.max_drive_hours_per_day;
      if (cap == null) return true;
      if (input.data.drive_time_minutes == null) return true;
      return input.data.drive_time_minutes <= cap * 60;
    },
    (input) => ({
      message: `data.drive_time_minutes (${input.data.drive_time_minutes}) exceeds vehicle.max_drive_hours_per_day (${ctx.vehicle?.max_drive_hours_per_day}h). If the route really needs more, split into separate legs via add_leg instead of growing this one.`,
      path: ['data', 'drive_time_minutes'],
    })
  );
}

export const tool: Anthropic.Tool = {
  name: UPDATE_LEG,
  description:
    'Update an existing leg by id. Only fields you supply in `data` are changed. Same drive-time cap as add_leg applies — if the route needs more time, split into multiple legs instead. leg_id must be the persistent database id from legs[].id in context (never sort_order nor "Day N").',
  input_schema: {
    type: 'object',
    required: ['leg_id', 'data'],
    properties: {
      leg_id: {
        type: 'integer',
        description: 'Persisted legs[].id from context for this trip (not sort_order, not ordinal).',
      },
      data: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          label: { type: 'string' },
          start_name: { type: 'string' },
          end_name: { type: 'string' },
          start_lat: { type: 'number', minimum: -90, maximum: 90 },
          start_lng: { type: 'number', minimum: -180, maximum: 180 },
          end_lat: { type: 'number', minimum: -90, maximum: 90 },
          end_lng: { type: 'number', minimum: -180, maximum: 180 },
          dates: { type: 'string' },
          distance_km: { type: 'number', minimum: 0 },
          drive_time_minutes: { type: 'integer', minimum: 0, maximum: 24 * 60 },
          terrain: { type: 'string', enum: ['highway', 'mixed', 'offroad', 'urban'] },
          overnight: { type: 'string' },
          status: { type: 'string', enum: ['planning', 'research', 'confirmed', 'anchored'] },
          color: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
          segment_index: {
            type: 'integer',
            minimum: 0,
            description:
              'Re-tag this day to a different jump (or pass null to ungroup). See add_leg for grouping rules.',
          },
          segment_name: {
            type: 'string',
            description: 'Updated jump label (e.g. "Girona → Berlin").',
          },
          costs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['item', 'estimate'],
              properties: {
                item: { type: 'string' },
                estimate: { type: 'string' },
                is_total: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};
