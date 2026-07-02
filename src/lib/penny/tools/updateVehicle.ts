import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const UPDATE_VEHICLE = 'update_vehicle' as const;

/**
 * LOCKED DOWN (2026-07-02): fuel_type ONLY.
 *
 * comfortable_range_km / hard_max_range_km were REMOVED from this tool. The
 * range numbers are safety-critical (Finn's "never run dry" math) and are now
 * writable ONLY via onboarding and Settings → Vehicle profile — never from
 * chat. The bug this closes: "I'll need to get fuel within 250km of
 * tomorrow's drive" is a fuel REQUEST (route to Finn via plan_fuel_stops),
 * but Penny pattern-matched it as a range preference and silently rewrote
 * comfortable_range_km. Do not re-add the range fields here.
 */
const dataSchema = z.object({
  /** Fuel the vehicle burns — drives which price Finn fetches. diesel | petrol. */
  fuel_type: z.enum(['diesel', 'petrol']),
});

const baseSchema = z.object({
  data: dataSchema,
});

export type UpdateVehicleInput = z.infer<typeof baseSchema>;

/**
 * The vehicle id comes from the context — Penny doesn't need to supply it.
 * The validator just checks the data fields; the dispatcher uses
 * ctx.vehicle.id (verified as owned by the session user) to write.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: UPDATE_VEHICLE,
  description: `
Save the vehicle's fuel type to the database. Call this when the user states what fuel their
vehicle burns, e.g. "it's a diesel" / "runs on petrol". Defaults to diesel if never set.

This tool can NOT change the vehicle's fuel-range numbers (comfortable range / hard-max
ceiling). Those are safety numbers set only in onboarding or Settings → Vehicle profile.
If the user wants to change them, tell them to do it in Settings → Vehicle profile.
If the user is asking about GETTING FUEL (where/when to refuel), that is a fuel request —
call plan_fuel_stops instead; never treat it as a preference change.
`.trim(),
  input_schema: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['fuel_type'],
        properties: {
          fuel_type: {
            type: 'string',
            enum: ['diesel', 'petrol'],
            description:
              "The fuel the vehicle burns. Needed to show the correct fuel price. Set when the user says e.g. \"it's a diesel\" / \"runs on petrol\". Defaults to diesel if never set.",
          },
        },
      },
    },
  },
};
