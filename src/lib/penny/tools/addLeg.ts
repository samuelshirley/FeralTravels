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
  /**
   * 'drive' for a driving day (default). 'rest' for a non-driving rest/stop day.
   * Rest days have no drive_time_minutes or distance_km — they represent days
   * spent at a location (e.g. 2 nights in Innsbruck).
   */
  leg_type: z.enum(['drive', 'rest']).nullish().default('drive'),
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
  /**
   * Insert this leg right AFTER an existing leg (its id from context.legs[]).
   * Use this for a mid-route stop so it lands in the right place instead of at
   * the end. Prefer this over guessing a raw sort_order.
   */
  after_leg_id: z.string().uuid().nullish(),
  // Two-level grouping. Each leg row is a *driving day*; segment_* tags
  // which user-stated jump it belongs to. Set both together — segment_index
  // gives stable ordering within the trip, segment_name is the label users
  // see ("Girona → Berlin"). Leave both null for short single-day jumps.
  segment_index: z.number().int().min(0).nullish(),
  segment_name: z.string().min(1).max(200).nullish(),
  // ── Constraints (for nightly replan) ──
  /** Constraints to attach to this leg — deadlines, earliest departures, or flexible intents. */
  constraints: z.array(z.object({
    constraint_type: z.enum(['arrive_by', 'depart_after', 'flexible']),
    /** ISO 8601 datetime with timezone. Required for arrive_by/depart_after, null for flexible. */
    datetime: z.string().nullish(),
    buffer_minutes: z.number().int().min(0).max(1440).optional().default(60),
    note: z.string().max(500).nullish(),
  })).max(5).optional().default([]),
});

export type AddLegInput = z.infer<typeof baseSchema>;

/**
 * Cross-field validator factory — needs vehicle context for the per-day cap.
 * If the vehicle isn't set or the cap isn't configured, we fall through —
 * static schema bounds (24h max) still apply.
 */
export function validator(ctx: PennyContext) {
  return baseSchema
    .refine(
      // A rest leg sits AT a location, so it must still carry both names and
      // both coordinate pairs (use the same coords for start and end). Without
      // them the leg is unusable downstream: repairLegContinuity can't anchor
      // it, planFuelStopsForLeg short-circuits to fuel_status 'none', and the
      // itinerary renders a location-less card — silent data corruption.
      (d) => {
        if (d.leg_type !== 'rest') return true;
        return (
          d.start_name != null &&
          d.end_name != null &&
          d.start_lat != null &&
          d.start_lng != null &&
          d.end_lat != null &&
          d.end_lng != null
        );
      },
      {
        message:
          'rest legs require start_name, end_name, and start/end coordinates (use the same coords for start and end — the rest day is AT a location).',
        path: ['start_name'],
      }
    )
    .refine(
      (d) => {
        // Rest days have no driving — skip the cap check.
        if (d.leg_type === 'rest') return true;
        // Use transit cap (longest tolerable day) for validation.
        // Falls back to legacy max_drive_hours_per_day for pre-migration vehicles.
        const cap = ctx.vehicle?.transit_max_drive_hours
          ?? ctx.vehicle?.max_drive_hours_per_day;
        if (cap == null) return true;
        if (d.drive_time_minutes == null) return true;
        return d.drive_time_minutes <= cap * 60;
      },
      (d) => {
        const cap = ctx.vehicle?.transit_max_drive_hours
          ?? ctx.vehicle?.max_drive_hours_per_day;
        return {
          message: `drive_time_minutes (${d.drive_time_minutes}) exceeds vehicle drive cap (${cap}h × 60 = ${(cap ?? 0) * 60} min). Call get_route to get the real route, then emit one add_leg per resulting day from the split.`,
          path: ['drive_time_minutes'],
        };
      }
    );
}

export const tool: Anthropic.Tool = {
  name: ADD_LEG,
  description: `Add a new leg to the trip — either a driving day or a rest/stop day. ${HEADING.callOrderRule}

DRIVING DAYS (leg_type: "drive" or omitted): Each driving leg represents ONE DRIVING DAY (≤ vehicle.max_drive_hours_per_day). For multi-day jumps, call get_route first then emit one add_leg per resulting day.

REST DAYS (leg_type: "rest"): When the user spends one or more nights at a location (e.g. "2 nights in Innsbruck"), emit rest-day legs for each day spent there. Rest days have no drive_time_minutes or distance_km — they represent time at a location. Use the same start/end coords as the location. Title format: "Innsbruck (rest day)". Add notes about planned activities if the user mentions any.

TITLE FORMAT: Do NOT include "Day N:" prefixes in titles. The UI computes calendar dates automatically from the trip start date. Just use the route description: "Girona → Lyon" for driving days, "Innsbruck (rest day)" for rest days.

GROUPING (segment_index / segment_name): When the user describes a destination jump that takes more than one driving day — e.g. "Girona to Berlin" stretching over 5 days — give every day in that jump the SAME segment_index (an integer, 0 for the first jump, 1 for the second, …) and the SAME segment_name (the user's words: "Girona → Berlin"). This is what lets the UI render long trips as collapsible sections.

Rest days at a stop use the SAME segment_index and segment_name as the drive leg that arrives there — e.g. 3 nights in Innsbruck after a "Girona → Innsbruck" jump all carry segment 0 / "Girona → Innsbruck" so they stay under one LEG header with the driving days.

Leave both fields null when the user-stated jump is itself only one day, or when you're not confident which jump a day belongs to. The UI falls back to a flat list when no segment data is set.

For "Barcelona → Paris → Berlin → Oslo": segment 0 covers all days from Barcelona to Paris, segment 1 all days Paris→Berlin, segment 2 all days Berlin→Oslo.`,
  input_schema: {
    type: 'object',
    required: ['title'],
    properties: {
      title: {
        type: 'string',
        description: 'Human-readable leg title. For driving days: "Girona → Lyon". For rest days: "Innsbruck (rest day)". Do NOT include "Day N:" — the UI adds calendar dates automatically.',
      },
      leg_type: {
        type: 'string',
        enum: ['drive', 'rest'],
        description: '"drive" (default) for a driving day, "rest" for a non-driving rest/stop day at a location.',
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
      after_leg_id: {
        type: 'string',
        format: 'uuid',
        description:
          'Insert this leg right after the leg with this id (from context.legs[]). Use for a mid-route stop so it lands in the correct position instead of at the end. Preferred over sort_order.',
      },
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
      constraints: {
        type: 'array',
        description:
          'Time constraints on this leg — deadlines ("be there by June 3"), earliest departures ("ferry at 2pm"), or flexible intents ("visit Neuschwanstein sometime"). Omit or [] for unconstrained legs.',
        items: {
          type: 'object',
          required: ['constraint_type'],
          properties: {
            constraint_type: {
              type: 'string',
              enum: ['arrive_by', 'depart_after', 'flexible'],
              description: 'arrive_by = hard arrival deadline. depart_after = cannot leave before this time. flexible = soft preference.',
            },
            datetime: {
              type: 'string',
              description: 'ISO 8601 datetime with timezone, e.g. "2026-06-03T15:00:00+02:00". Required for arrive_by/depart_after.',
            },
            buffer_minutes: {
              type: 'integer',
              minimum: 0,
              maximum: 1440,
              description: 'Minutes of slack. Default 60.',
            },
            note: {
              type: 'string',
              description: 'User-facing reason, e.g. "ferry departs at 2pm".',
            },
          },
        },
      },
    },
  },
};
