import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const RENAME_TRIP = 'rename_trip' as const;

const baseSchema = z.object({
  name: z
    .string()
    .min(1, 'Trip name cannot be empty')
    .max(200, 'Trip name is too long (max 200 characters)'),
  /**
   * Optional trip start date. Any parseable date string is fine —
   * "2026-05-28", "May 28, 2026", "Jun 1", etc. The server parses
   * it into ISO YYYY-MM-DD so the UI can show real calendar dates
   * on each leg instead of "Day 1", "Day 2".
   */
  start_date: z.string().max(100).nullish(),
  /** Optional trip end date, same format as start_date. */
  end_date: z.string().max(100).nullish(),
});

export type RenameTripInput = z.infer<typeof baseSchema>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: RENAME_TRIP,
  description: `
Update the trip's name and/or dates. Call this when:
- The user tells you what they'd like to name their trip
- You know the trip's start and/or end dates (from the user's request, constraints, or the planned itinerary)

ALWAYS set start_date when you know it — the UI uses it to show real calendar dates on each leg (e.g. "Wed 28 May") instead of generic "Day 1", "Day 2" labels. If the user said "leaving May 28" or you can infer it from constraints, set it here.

The name should be short and descriptive — e.g. "Spain to Gorafe", "Nordic Adventure", "Morocco Coast Run".
`.trim(),
  input_schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'The new name for the trip.',
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
