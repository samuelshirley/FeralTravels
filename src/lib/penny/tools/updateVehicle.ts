import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
} from '@/lib/vehicleProfile';

export const UPDATE_VEHICLE = 'update_vehicle' as const;

/**
 * Only preference fields — not vehicle name, not is_default.
 * Penny can only change how the vehicle is driven, not rename it.
 *
 * All fields are optional so Penny can do partial updates (e.g. only
 * max_drive_hours_per_day) without having to supply values she doesn't know.
 */
const dataSchema = z.object({
  /** Max hours of driving per calendar day. E.g. 6 means no leg > 6h. */
  max_drive_hours_per_day: z
    .number()
    .positive()
    .max(24, 'max_drive_hours_per_day cannot exceed 24')
    .nullish(),

  /** Max total driving hours across the whole week. */
  max_drive_hours_per_week: z
    .number()
    .positive()
    .max(168, 'max_drive_hours_per_week cannot exceed 168')
    .nullish(),

  /** Max consecutive driving days before a mandatory rest day. */
  max_consecutive_drive_days: z
    .number()
    .int()
    .positive()
    .max(
      MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
      `max_consecutive_drive_days cannot exceed ${MAX_CONSECUTIVE_DRIVE_DAYS_CAP}`
    )
    .nullish(),

  /** Preferred distance (km) between fuel refills. */
  refill_distance_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),

  /** Days between fresh-water refills. */
  water_refill_days: z.number().int().positive().max(30).nullish(),

  /** Days between blackwater (waste) tank empties. */
  blackwater_refill_days: z.number().int().positive().max(30).nullish(),
});

const baseSchema = z.object({
  data: dataSchema.refine(
    (d) => Object.values(d).some((v) => v != null),
    { message: 'At least one field must be supplied in data.' }
  ),
});

export type UpdateVehicleInput = z.infer<typeof baseSchema>;

/**
 * The vehicle id comes from the context — Penny doesn't need to supply it.
 * The validator just checks the data fields are in range; the dispatcher
 * uses ctx.vehicle.id (verified as owned by the session user) to write.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: UPDATE_VEHICLE,
  description: `
Save updated vehicle driving preferences to the database. Call this whenever the user states or changes:
- daily driving limit (max hours per day)
- weekly driving cadence (e.g. "3 days a week", "drive 4 days then rest 3")
- refuel cadence or range (km between fuel stops)
- water or blackwater refill intervals

The API requires refill_distance_km between 200 and 1500 km for fuel planning. If the trip vehicle may still be missing that
value (new or stub profile), include refill_distance_km in this update whenever the user gives a range or you
infer one; otherwise PATCH may reject partial preference-only updates.

Parse the user's freeform answer into metric numbers and call this tool.
Common patterns:
  "6 hours a day, 3 days a week" → max_drive_hours_per_day: 6, max_consecutive_drive_days: 3
  "I like to refuel every 400 km" → refill_distance_km: 400
  "drive for 4 days then take a break" → max_consecutive_drive_days: 4

After calling this tool and receiving success, confirm the saved values in one sentence
and proceed with planning using the new preferences. Note: leg validation in the current
turn still uses the previous context values — if you need the new cap to apply to legs
you're about to add, tell the user you've saved the preferences and ask them to send
their planning request again so the updated values take effect.
`.trim(),
  input_schema: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        description: 'Fields to update. Only supply fields the user explicitly stated.',
        properties: {
          max_drive_hours_per_day: {
            type: 'number',
            minimum: 0.5,
            maximum: 24,
            description: 'Hours of driving per day the user is comfortable with.',
          },
          max_drive_hours_per_week: {
            type: 'number',
            minimum: 0.5,
            maximum: 168,
            description:
              'Total driving hours the user wants per week. Derive from "X days a week × Y hours/day" when both are stated.',
          },
          max_consecutive_drive_days: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
            description:
              'Max days of driving in a row before a rest day. "3 days a week" → 3; "drive 5, rest 2" → 5.',
          },
          refill_distance_km: {
            type: 'integer',
            minimum: FUEL_STOP_SPACING_KM_MIN,
            maximum: FUEL_STOP_SPACING_KM_MAX,
            description: 'Preferred km between fuel refills (the user-stated range).',
          },
          water_refill_days: {
            type: 'integer',
            minimum: 1,
            maximum: 30,
            description: 'Days between fresh-water refills.',
          },
          blackwater_refill_days: {
            type: 'integer',
            minimum: 1,
            maximum: 30,
            description: 'Days between blackwater (waste) tank empties.',
          },
        },
      },
    },
  },
};
