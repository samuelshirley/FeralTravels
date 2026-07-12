import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const DECLARE_FUEL_STATE = 'declare_fuel_state' as const;

/**
 * declare_fuel_state — record the driver's OWN statement of their tank state:
 * "I only have ~150 km of range left", "I'll run out 150 km into tomorrow's
 * drive". This is the third fuel category alongside range PREFERENCES
 * (Settings-only) and fuel REQUESTS (plan_fuel_stops):
 *
 *   - It does NOT touch the vehicle's saved comfortable/hard-max range — those
 *     are durable safety numbers about the vehicle. The declaration is about
 *     the fuel in the tank right now, on this trip.
 *   - Finn's tank math treats it as the remaining-range baseline at the anchor
 *     leg's start, overriding the default "full tank at trip start". A real
 *     fuel stop after the anchor supersedes it (refuelling resets the tank).
 *
 * Origin incident (trip d0b5741b, 2026-07-12): the driver said their truck
 * would run dry 150 km into the next day's leg; the saved comfortable range
 * (500 km) put Finn's stop at 181 km — past empty — and no tool existed to
 * feed the real tank state in. Penny could only argue or point at Settings
 * (which would have corrupted the durable range to fix a one-day problem).
 *
 * Runs INLINE in the tool-use loop (a lookup with a DB write, like
 * plan_fuel_stops) so a plan_fuel_stops call in the SAME turn sees the
 * declaration — the natural flow is declare → re-run Finn → report honestly.
 */

const baseSchema = z.object({
  leg_id: z.string().uuid(),
  remaining_range_km: z.number().positive(),
});

export type DeclareFuelStateInput = z.infer<typeof baseSchema>;

export function validator(ctx: PennyContext) {
  return baseSchema.superRefine((input, refCtx) => {
    const leg = ctx.legs.find((l) => l.id === input.leg_id);
    if (!leg) {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leg_id'],
        message:
          'leg_id does not match a saved leg on this trip. Use the persisted legs[].id from context — a leg added earlier in this same turn is not saved yet.',
      });
      return;
    }
    if (leg.leg_type === 'rest') {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leg_id'],
        message:
          'Tank state anchors to a DRIVE leg (the declaration means "this much range when I start driving this leg"). Anchor it to the next drive leg instead of a rest day.',
      });
    }
    const hardMax = ctx.vehicle?.hard_max_range_km ?? ctx.vehicle?.comfortable_range_km ?? null;
    if (hardMax != null && input.remaining_range_km > hardMax) {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining_range_km'],
        message:
          `remaining_range_km (${input.remaining_range_km}) exceeds the vehicle's hard-max range (${hardMax} km) — a tank cannot hold more than the vehicle's ceiling. ` +
          'If the user is saying their vehicle can actually go further, that is a range PREFERENCE: point them to Settings → Vehicle profile (see <vehicle_preference_updates>).',
      });
    }
  });
}

export const tool: Anthropic.Tool = {
  name: DECLARE_FUEL_STATE,
  description:
    'Record the driver\'s stated CURRENT tank state: how many km they can drive from the START of a specific leg before needing fuel ("I only have 150 km in the tank", "I\'ll run dry 150 km into tomorrow"). This corrects Finn\'s remaining-range math for the trip WITHOUT touching the vehicle\'s saved range numbers (those are Settings-only preferences — see <vehicle_preference_updates>). After declaring, call plan_fuel_stops for the same leg so Finn re-plans with the corrected tank. The declaration is superseded automatically once a fuel stop is passed (refuelling resets the tank). If the user gives a "right now" number while mid-drive, ask ONE clarifying question to pin the km remaining at the NEXT leg\'s start before declaring — do not guess.',
  input_schema: {
    type: 'object',
    required: ['leg_id', 'remaining_range_km'],
    properties: {
      leg_id: {
        type: 'string',
        format: 'uuid',
        description:
          'Persisted legs[].id (UUID) of the DRIVE leg whose start the declaration applies to — usually the leg the driver is about to drive next.',
      },
      remaining_range_km: {
        type: 'number',
        minimum: 1,
        description:
          'How many km the driver says they can cover from the start of that leg before running out of fuel. Must not exceed the vehicle\'s hard-max range.',
      },
    },
  },
};
