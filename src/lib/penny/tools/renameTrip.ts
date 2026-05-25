import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const RENAME_TRIP = 'rename_trip' as const;

const baseSchema = z
  .object({
    /**
     * Optional. The app auto-names the trip from its season/dates, so normally
     * leave this out and just set the dates. Set it only when the user
     * explicitly asks for a specific name; omitting it preserves the auto-name
     * (or any name already in place).
     */
    name: z
      .string()
      .min(1, 'Trip name cannot be empty')
      .max(200, 'Trip name is too long (max 200 characters)')
      .optional(),
    /**
     * Optional trip start date. Any parseable date string is fine —
     * "2026-05-28", "May 28, 2026", "Jun 1", etc. The server parses
     * it into ISO YYYY-MM-DD so the UI can show real calendar dates
     * on each leg instead of "Day 1", "Day 2".
     */
    start_date: z.string().max(100).nullish(),
    /** Optional trip end date, same format as start_date. */
    end_date: z.string().max(100).nullish(),
  })
  .refine((v) => v.name !== undefined || v.start_date != null || v.end_date != null, {
    message: 'Provide a name and/or start/end dates to update.',
  });

export type RenameTripInput = z.infer<typeof baseSchema>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: RENAME_TRIP,
  description: `
Set the trip's dates (and, only when the user explicitly asks, its name).

ALWAYS set start_date when you know it — the UI uses it to show real calendar dates on each leg (e.g. "Wed 28 May") instead of generic "Day 1", "Day 2" labels. If the user said "leaving May 28" or you can infer it from constraints, set it here. Set end_date too when you know it.

You normally do NOT name the trip: the app auto-names it from its season/dates ("June '26 Trip", "Summer '26 Trip") as soon as a start_date is set. Pass name ONLY when the user explicitly asks for a specific trip name; otherwise omit it so the auto-name (or an existing name) stands.
`.trim(),
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'A specific trip name. Only set this when the user explicitly asks to name/rename the trip — otherwise omit it and let the app auto-name the trip from its season/dates.',
      },
      start_date: {
        type: 'string',
        description:
          'Trip departure date — any common format: "2026-05-28", "May 28, 2026", "Jun 1". Sets calendar dates on all legs in the itinerary. Omit only when no departure date is known.',
      },
      end_date: {
        type: 'string',
        description:
          'Trip end/return date, same format as start_date. Omit when unknown.',
      },
    },
  },
};
