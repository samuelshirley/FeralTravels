import 'server-only';
import { z } from 'zod';

/**
 * Shared Zod subschemas reused across Penny's tool validators.
 *
 * Two principles:
 * 1. Bounds-check primitives so a parse error fires close to the failing
 *    field, not later in the dispatcher with a SQL constraint violation.
 * 2. Use `.nullish()` (accepts null OR undefined) generously — Claude's
 *    JSON output omits unset fields sometimes and writes `null` other
 *    times, and we'd rather accept both than retry on the difference.
 */

export const latSchema = z.number().min(-90).max(90);
export const lngSchema = z.number().min(-180).max(180);

export const positiveIntSchema = z.number().int().positive();

/** Distance in km. Hard ceiling at 100,000 — anything more is data corruption. */
export const distanceKmSchema = z.number().positive().max(100_000);

/**
 * Drive time in minutes. Static cap at 24h here so a parser error fires for
 * obvious garbage; the real per-vehicle cap (max_drive_hours_per_day) is
 * enforced as a cross-field refinement on add_leg / update_leg.
 */
export const driveTimeMinutesSchema = z.number().int().positive().max(24 * 60);

export const legStatusSchema = z.enum(['planning', 'research', 'confirmed', 'anchored']);
export const routeStatusSchema = z.enum(['option', 'selected', 'dismissed']);
export const stopStatusSchema = z.enum(['option', 'selected', 'dismissed']);
export const taskStatusSchema = z.enum(['open', 'answered', 'dismissed']);
export const taskPrioritySchema = z.enum(['low', 'normal', 'high']);

export const stopTypeSchema = z.enum(['fuel', 'other']);
export const fuelTypeSchema = z.enum(['diesel', 'petrol', 'premium', 'lpg']);
export const stopSourceSchema = z.enum(['penny', 'user', 'google_places', 'osm', 'manual']);
export const surfaceSchema = z.enum(['paved', 'gravel', 'mix']);
export const terrainSchema = z.enum(['highway', 'mixed', 'offroad', 'urban']);

export const routeLinkTypeSchema = z.enum([
  'gpx',
  'google_maps',
  'wikiloc',
  'komoot',
  'gaia',
  'dog_park',
  'park',
  'other',
]);

/**
 * URL string. Loose-but-structural — a real URL parse, no protocol allowlist
 * (we want to accept https://, http://, and the occasional google_maps:// or
 * comgooglemaps:// scheme without rewriting the validator every time).
 */
export const urlSchema = z.string().url();

export const routeLinkSchema = z.object({
  type: routeLinkTypeSchema,
  label: z.string().min(1),
  url: urlSchema,
});

/**
 * Helpers for tool descriptions — these strings ship to Claude as part of
 * the tool definition, so wording matters. Keep them short and prescriptive.
 */
export const HEADING = {
  callOrderRule:
    'IMPORTANT: For any new multi-day plan or any leg whose start/end you do not already have authoritative coordinates for, call get_route FIRST. Use the returned distance_km, drive_time_minutes, polyline, and any per-day split provided. Never guess these numbers — the validator rejects legs that exceed the vehicle\'s daily driving cap and Sam will see your retry as a quality regression.',
};

/**
 * Format a Zod error for tool_result feedback to Claude.
 *
 * We strip the noisy `_errors` wrapper and emit a flat list of "field: msg"
 * lines so Claude can map each line to a field it emitted. Keeping it short
 * matters — every retry repeats this in the conversation.
 */
export function zodErrorToFeedback(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
