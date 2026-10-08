import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

/**
 * hold_for_confirmation — Penny's STRUCTURED way to say "this turn is a
 * question, and the writes I queued are my answer to yes".
 *
 * Why it exists (trip 9a3df982, 2026-10-08): Penny asked "Both good?", the
 * driver said "yup", and that cost another full model call — which asked
 * again. Now, when she would ask a yes/no confirmation about a concrete change,
 * she does the work for the "yes" in the SAME turn (resolve_place with her own
 * recommendation, get_route, the add_leg / add_stop / update_* calls) and
 * calls this. The route stages those writes on the turn row instead of
 * applying them. If the driver's next message is a deterministic yes ("yup",
 * "sounds good", "whatever you choose" — lib/penny/acceptance.ts), the server
 * applies them with NO model call; anything else discards the stage and goes
 * to Penny as usual. See lib/penny/stagedPlan.ts and server/pennyStage.ts.
 *
 * A LOOKUP tool (runs inline, writes nothing) so the result can tell her the
 * hold is in place before she writes her question. Never prose parsing: the
 * hold is this call, not anything she says.
 */

export const HOLD_FOR_CONFIRMATION = 'hold_for_confirmation' as const;

const baseSchema = z.object({
  /**
   * The yes/no question she is about to end her message with. Kept on the
   * stage for diagnosis; the server matches the user's reply against her
   * persisted message, never against this.
   */
  question: z.string().min(3).max(300),
});

export type HoldForConfirmationInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: HOLD_FOR_CONFIRMATION,
  description:
    'Make THIS turn a yes/no question whose "yes" is already prepared. Use it whenever you would ask the user to confirm a concrete change ("Both good?", "Shall I add Gorafe after Tabernas?"). First do the work the YES answer needs, in this same turn, using your own recommendation: resolve_place, get_route, check_trip_feasibility if planning, then queue the add_leg / add_stop / update_* calls. Then call this, and end your message with the question. Every write you queue this turn is HELD, not applied: if the user answers yes, the server applies exactly those writes without asking you again; anything else discards them and you get their message as usual. Do not call it for an open question with no concrete change behind it ("Want to adjust anything?"), and do not call it if you queued nothing. It cannot hold plan_fuel_stops or declare_fuel_state — those take effect immediately.',
  input_schema: {
    type: 'object',
    required: ['question'],
    properties: {
      question: {
        type: 'string',
        description: 'The yes/no question you will end your message with, verbatim.',
        maxLength: 300,
      },
    },
  },
};
