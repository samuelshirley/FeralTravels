import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { latSchema, lngSchema } from './shared';

export const REPORT_POSITION = 'report_position' as const;

const baseSchema = z.object({
  /** The driver's CURRENT position (best-effort coords for the town they're in). */
  lat: latSchema,
  lng: lngSchema,
  /** Human-readable name of where they are now, e.g. "Zürich". */
  place_name: z.string().min(1).max(200).nullish(),
  /**
   * The id (from context.legs[]) of the leg the driver will drive NEXT — the
   * upcoming drive out of their current position. Omit only if you genuinely
   * can't tell; the server then picks the nearest upcoming drive leg.
   */
  next_leg_id: z.string().uuid().nullish(),
  /**
   * ISO "YYYY-MM-DD" the driver will resume driving (the date the next leg
   * should fall on). Use context's today for "today"/"now", today+1 for
   * "tomorrow", etc. Omit to default to today.
   */
  resume_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'resume_date must be ISO YYYY-MM-DD')
    .nullish(),
  /** Optional free-text note, e.g. "stopped short, too tired to push on". */
  note: z.string().max(500).nullish(),
});

export type ReportPositionInput = z.infer<typeof baseSchema>;

export function validator(ctx: PennyContext) {
  return baseSchema.superRefine((input, refCtx) => {
    if (input.next_leg_id != null && !ctx.legs.some((l) => l.id === input.next_leg_id)) {
      refCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['next_leg_id'],
        message:
          'next_leg_id is not a leg on this trip. Use an id from context.legs[], or omit it to let the server pick the nearest upcoming leg.',
      });
    }
  });
}

export const tool: Anthropic.Tool = {
  name: REPORT_POSITION,
  description: `Record where the driver ACTUALLY is right now and re-anchor the trip to reality. Call this whenever the user tells you their real-world position or progress — "I'm in Zürich", "we only made it to X", "I didn't reach Y", "we're at Z now", "I'm a day behind". This is the ONLY way to update the trip's current position; do not try to fake it by editing legs.

What it does (server-side, deterministically): sets the current-position marker, re-points the upcoming leg to start from where the driver actually is (re-routing its distance/time), marks the earlier days as behind them (the itinerary collapses them), and re-dates the remaining legs from now. You do NOT compute any of those dates or distances yourself.

Provide:
- lat/lng for where they are now (best-effort coords for the town are fine).
- place_name (the town/city).
- next_leg_id: the leg from context.legs[] they'll drive NEXT. E.g. if they fell short and want to continue to Innsbruck, that's the leg ending at Innsbruck.
- resume_date (ISO): when they'll drive next. "tomorrow morning" → today+1. Omit for today.

After calling, confirm briefly in prose ("Got it — you're in Zürich; I've set tomorrow's drive to continue to Innsbruck.") WITHOUT stating dates/counts — the plan summary card shows those.`,
  input_schema: {
    type: 'object',
    required: ['lat', 'lng'],
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
      place_name: { type: 'string', description: 'Town/city where the driver is now, e.g. "Zürich".' },
      next_leg_id: {
        type: 'string',
        format: 'uuid',
        description:
          'Id (from context.legs[]) of the leg the driver will drive NEXT out of their current position. Omit only if genuinely unknown.',
      },
      resume_date: {
        type: 'string',
        description:
          'ISO YYYY-MM-DD the driver resumes driving (date the next leg falls on). "tomorrow" → today+1. Omit for today.',
      },
      note: { type: 'string', description: 'Optional context, e.g. why they stopped short.' },
    },
  },
};
