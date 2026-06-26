import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
} from '@/lib/vehicleProfile';

export const UPDATE_VEHICLE = 'update_vehicle' as const;

/**
 * Only the fuel-range preferences — not vehicle name, not is_default.
 * MVP scope: Penny can change the comfortable range and the hard-max ceiling.
 *
 * Both fields are optional so Penny can do partial updates without having to
 * supply a value she doesn't know.
 */
const dataSchema = z.object({
  /** Preferred distance (km) between fuel refills — the comfortable range. */
  comfortable_range_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),

  /** Hard ceiling (km) — never route a dry stretch past this. Must be ≥ comfortable. */
  hard_max_range_km: z
    .number()
    .int()
    .min(FUEL_STOP_SPACING_KM_MIN)
    .max(FUEL_STOP_SPACING_KM_MAX)
    .nullish(),
});

const baseSchema = z.object({
  data: dataSchema
    .refine((d) => Object.values(d).some((v) => v != null), {
      message: 'At least one field must be supplied in data.',
    })
    .refine(
      (d) =>
        d.comfortable_range_km == null ||
        d.hard_max_range_km == null ||
        d.hard_max_range_km >= d.comfortable_range_km,
      {
        message: 'hard_max_range_km must be ≥ comfortable_range_km.',
        path: ['hard_max_range_km'],
      }
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
Save the vehicle's fuel-range preferences to the database. Call this whenever the user states or changes:
- their comfortable range / refuel cadence (km they're happy to drive before refuelling)
- their hard-max range (the absolute ceiling they'd never be routed past)

The API requires comfortable_range_km between 200 and 1500 km for fuel planning. If the trip vehicle may still be missing that
value (new or stub profile), include comfortable_range_km in this update whenever the user gives a range or you
infer one; otherwise PATCH may reject partial updates.

Parse the user's freeform answer and call this tool.
Common patterns:
  "I like to refuel every 400 km" → comfortable_range_km: 400
  "I can stretch to 600 km in a pinch" → hard_max_range_km: 600

After calling this tool and receiving success, confirm the saved values in one sentence
and proceed with planning using the new preferences. Note: leg validation in the current
turn still uses the previous context values — if you need the new range to apply to legs
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
          comfortable_range_km: {
            type: 'integer',
            minimum: FUEL_STOP_SPACING_KM_MIN,
            maximum: FUEL_STOP_SPACING_KM_MAX,
            description:
              'Preferred km between fuel refills — the comfortable range the user is happy to drive before refuelling.',
          },
          hard_max_range_km: {
            type: 'integer',
            minimum: FUEL_STOP_SPACING_KM_MIN,
            maximum: FUEL_STOP_SPACING_KM_MAX,
            description:
              'Hard ceiling (km) the user will never be routed past, for any reason. Must be ≥ comfortable_range_km. Set when the user says how far they would stretch in a pinch.',
          },
        },
      },
    },
  },
};
