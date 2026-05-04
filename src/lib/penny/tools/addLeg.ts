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
  // Two-level grouping. Each leg row is a *driving day*; segment_* tags
  // which user-stated jump it belongs to. Set both together — segment_index
  // gives stable ordering within the trip, segment_name is the label users
  // see ("Girona → Berlin"). Leave both null for short single-day jumps.
  segment_index: z.number().int().min(0).nullish(),
  segment_name: z.string().min(1).max(200).nullish(),
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
  description: `Add a new driving leg to the trip. ${HEADING.callOrderRule} Each leg you add represents ONE DRIVING DAY (≤ vehicle.max_drive_hours_per_day). For multi-day jumps, call get_route first then emit one add_leg per resulting day.

GROUPING (segment_index / segment_name): When the user describes a destination jump that takes more than one driving day — e.g. "Girona to Berlin" stretching over 5 days — give every day in that jump the SAME segment_index (an integer, 0 for the first jump, 1 for the second, …) and the SAME segment_name (the user's words: "Girona → Berlin"). This is what lets the UI render long trips as collapsible sections.

Leave both fields null when the user-stated jump is itself only one day, or when you're not confident which jump a day belongs to. The UI falls back to a flat list when no segment data is set.

For "Barcelona → Paris → Berlin → Oslo": segment 0 covers all days from Barcelona to Paris, segment 1 all days Paris→Berlin, segment 2 all days Berlin→Oslo.`,
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
      segment_index: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional 0-based index of the user-stated jump this day belongs to. All days inside the same jump share this value. Leave omitted for single-day jumps.',
      },
      segment_name: {
        type: 'string',
        description:
          'Optional human label for the jump this day belongs to, e.g. "Girona → Berlin". Must be set together with segment_index.',
      },
    },
  },
};
