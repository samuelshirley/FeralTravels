import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { DEFAULT_MAX_DRIVE_HOURS_PER_DAY } from '@/lib/vehicleProfile';
import {
  distanceKmSchema,
  driveTimeMinutesSchema,
  latSchema,
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
  leg_id: z.string().uuid(),
  data: dataSchema,
});

export type UpdateLegInput = z.infer<typeof baseSchema>;

/**
 * Fields that redefine a leg's identity as a drive: where it goes and how far.
 * On a REST leg these are meaningless — the deterministic scheduler
 * (rebuildTripSchedule) re-materializes every rest day as "stay at the previous
 * drive's end", so any location/metric edit Penny lands here is silently
 * reverted seconds later while her prose claims it saved (the "campsite near
 * Alset" bug: a rest day was update_leg'd into a pseudo-drive, the rebuild put
 * it back in Trondheim, and the user was told the campsite was saved).
 * Blocking at validation time turns that silent divergence into an in-loop
 * tool error Penny can react to within the same turn.
 */
const REST_LEG_BLOCKED_FIELDS = [
  'title',
  'start_name',
  'end_name',
  'start_lat',
  'start_lng',
  'end_lat',
  'end_lng',
  'distance_km',
  'drive_time_minutes',
] as const;

/** Which blocked fields does this patch touch? Pure — shared by the validator and the apply-time guard. */
export function restLegBlockedFields(data: Record<string, unknown>): string[] {
  return REST_LEG_BLOCKED_FIELDS.filter((f) => data[f] !== undefined);
}

/** The instructive rejection Penny sees in-loop (and the user sees on the apply-time path). */
export function restLegEditRejectionMessage(blocked: string[]): string {
  return (
    `This leg is a rest day — rest days always stay at the previous drive's end, and the ` +
    `schedule rebuild will revert location/route edits on them (blocked fields: ${blocked.join(', ')}). ` +
    `Do NOT convert a rest day into a drive. To take the driver somewhere: change the ` +
    `surrounding DRIVE leg's destination (update_leg on that leg), add a waypoint on it ` +
    `(add_stop), or restructure the days with add_leg/delete_leg. Non-route fields on this ` +
    `rest day (notes, status, color, costs) are still editable.`
  );
}

export function validator(ctx: PennyContext) {
  return baseSchema.superRefine((input, issueCtx) => {
    const cap = DEFAULT_MAX_DRIVE_HOURS_PER_DAY;
    if (input.data.drive_time_minutes != null && input.data.drive_time_minutes > cap * 60) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data.drive_time_minutes (${input.data.drive_time_minutes}) exceeds vehicle drive cap (${cap}h). If the route really needs more, split into separate legs via add_leg instead of growing this one.`,
        path: ['data', 'drive_time_minutes'],
      });
    }

    // Rest-leg guard. Context legs are a snapshot from the start of the turn;
    // a leg we can't find here (e.g. one added earlier in this same turn) is
    // skipped — the apply-time guard in the dispatcher covers that path.
    const leg = ctx.legs?.find((l) => l.id === input.leg_id);
    if (leg && leg.leg_type === 'rest') {
      const blocked = restLegBlockedFields(input.data as Record<string, unknown>);
      if (blocked.length > 0) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: restLegEditRejectionMessage(blocked),
          path: ['data'],
        });
      }
    }
  });
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
        type: 'string',
        format: 'uuid',
        description: 'Persisted legs[].id (UUID) from context for this trip (not sort_order, not ordinal).',
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
