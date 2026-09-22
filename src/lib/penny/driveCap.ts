import { DEFAULT_MAX_DRIVE_HOURS_PER_DAY } from '@/lib/vehicleProfile';

/**
 * The longest driving day this trip allows, in hours.
 *
 * The driver's own `trip_pace` answer when they gave one (1 to
 * DAILY_DRIVE_HOURS_MAX), else DEFAULT_MAX_DRIVE_HOURS_PER_DAY. An explicit
 * answer wins in BOTH directions. get_route splits on this number and the
 * add_leg / update_leg validators enforce it, all through this one function:
 * until 2026-09-22 each kept its own copy, two of them clamped to a flat 8h, and
 * the app accepted a longer answer and quietly planned 8h days anyway.
 * docs/design/drive-hours-cap.md
 */
export function tripDriveCapHours(trip: { daily_drive_hours: number | null }): number {
  return trip.daily_drive_hours ?? DEFAULT_MAX_DRIVE_HOURS_PER_DAY;
}
