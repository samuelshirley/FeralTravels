import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  HEADING,
  distanceKmSchema,
  driveTimeMinutesSchema,
  latSchema,
  legStatusSchema,
  lngSchema,
  terrainSchema,
} from './shared';

/**
 * add_leg — append a new driving leg to the trip. The 21-hour-day-2 bug
 * lives here: Penny used to invent drive_time_minutes from training data,
 * the dispatcher never checked, and the leg got saved as-is. Now we cap it
 * at the vehicle's max_drive_hours_per_day and bounce back to Penny on
 * violation so she can call get_route + split into multiple add_leg calls.
 */

export const ADD_LEG = 'add_leg' as const;

const baseSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
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
  sort_order: z.number().int().nullish(),
});

export type AddLegInput = z.infer<typeof baseSchema>;

/**
 * Cross-field validator factory — needs vehicle context for the per-day cap.
 * If the vehicle isn't set or the cap isn't configured, we fall through —
 * static schema bounds (24h max) still apply.
 */
export function validator(ctx: PennyContext) {
  return baseSchema.refine(
    (d) => {
      const cap = ctx.vehicle?.max_drive_hours_per_day;
      if (cap == null) return true;
      if (d.drive_time_minutes == null) return true;
      return d.drive_time_minutes <= cap * 60;
    },
    (d) => ({
      message: `drive_time_minutes (${d.drive_time_minutes}) exceeds vehicle.max_drive_hours_per_day (${ctx.vehicle?.max_drive_hours_per_day}h × 60 = ${(ctx.vehicle?.max_drive_hours_per_day ?? 0) * 60} min). Call get_route to get the real route, then emit one add_leg per resulting day from the split.`,
      path: ['drive_time_minutes'],
    })
  );
}

export const tool: Anthropic.Tool = {
  name: ADD_LEG,
  description: `Add a new driving leg to the trip. ${HEADING.callOrderRule} Each leg should fit within one driving day (≤ vehicle.max_drive_hours_per_day). For routes that exceed that, call get_route first and emit one add_leg per resulting day.`,
  input_schema: {
    type: 'object',
    required: ['title'],
    properties: {
      title: {
        type: 'string',
        description: 'Human-readable leg title, e.g. "Day 1: Girona → Lyon" or "Girona → Nice".',
      },
      label: { type: 'string', description: 'Optional short label for compact UI rendering.' },
      start_name: { type: 'string', description: 'Free-text name of the start point.' },
      end_name: { type: 'string', description: 'Free-text name of the end point.' },
      start_lat: { type: 'number', minimum: -90, maximum: 90 },
      start_lng: { type: 'number', minimum: -180, maximum: 180 },
      end_lat: { type: 'number', minimum: -90, maximum: 90 },
      end_lng: { type: 'number', minimum: -180, maximum: 180 },
      dates: {
        type: 'string',
        description: 'Optional free-text date range, e.g. "Jun 12-13".',
      },
      distance_km: {
        type: 'number',
        minimum: 0,
        description: 'Total driving distance for this leg, kilometres. Use the value returned by get_route.',
      },
      drive_time_minutes: {
        type: 'integer',
        minimum: 0,
        maximum: 24 * 60,
        description:
          'Total drive time, minutes. MUST be ≤ vehicle.max_drive_hours_per_day × 60. Use the value returned by get_route or the per-day split it provides.',
      },
      terrain: { type: 'string', enum: ['highway', 'mixed', 'offroad', 'urban'] },
      overnight: { type: 'string', description: 'Optional name of the overnight stop.' },
      status: {
        type: 'string',
        enum: ['planning', 'research', 'confirmed', 'anchored'],
        description: 'Default to "planning" for new legs unless the user explicitly confirms.',
      },
      color: { type: 'string' },
      notes: { type: 'array', items: { type: 'string' } },
      sort_order: { type: 'integer' },
    },
  },
};
