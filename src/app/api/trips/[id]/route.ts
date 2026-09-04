import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { trips, vehicles } from '@/server/db/schema';
import {
  HttpError,
  requireUserId,
  assertTripOwnedByUser,
  isAdmin,
  errorResponse,
} from '@/server/auth/guards';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';
import {
  getVehicleForUser,
} from '@/server/repos/vehicles';
import { auth } from '@/server/auth';
import {
  deleteTrip,
  assertTripNameAvailable,
  assertTripDurationWithinLimit,
} from '@/server/repos/trips';
import { rowMappers } from '@/server/repos/trips';
import { invalidateTripFuelCache } from '@/server/fuel';
import { parseUUID } from '@/lib/validation';
import { tryParseToISO } from '@/lib/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  status: z.string().max(40).optional(),
  // null = explicitly clear; string UUID = set to a vehicle the user owns.
  vehicle_id: z.string().uuid().nullable().optional(),
  /** Google Directions `avoid=highways` (motorways); merged into Penny get_route */
  prefer_avoid_highways: z.boolean().optional(),
  /** Hours of driving a day (1–8), or null for the flat default. */
  daily_drive_hours: z.number().int().min(1).max(8).nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    await assertTripOwnedByUser(tripId, userId);

    const body = patchSchema.parse(await req.json());

    // Reject rename collisions against the user's other trips (case-insensitive,
    // trimmed). Excluding tripId from the check so a no-op rename doesn't fight
    // with itself. The DB unique index on (user_id, lower(trim(name))) is the
    // real backstop; this gives us the friendlier error message.
    if (body.name !== undefined) {
      await assertTripNameAvailable(userId, body.name, tripId);
    }

    // If vehicle_id is being set, verify the user actually owns that vehicle
    // — otherwise a malicious client could attach someone else's vehicle to
    // their trip.
    if (typeof body.vehicle_id === 'string') {
      const owned = await db
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(and(eq(vehicles.userId, userId), eq(vehicles.id, body.vehicle_id)))
        .limit(1);
      if (owned.length === 0) {
        return Response.json({ error: 'Vehicle not found' }, { status: 404 });
      }
      const v = await getVehicleForUser(userId, body.vehicle_id);
      if (v && !vehicleMeetsFuelPlanningMinimum(v as Record<string, unknown>)) {
        throw new HttpError(
          400,
          'This vehicle needs a refill distance (km between fuel stops) before it can be used on a trip.'
        );
      }
    }

    // Enforce the 2-year max trip duration. PATCH may update only one of the
    // two date fields, so merge the incoming change against the current
    // persisted dates before checking — otherwise a partial PATCH could push
    // a previously-valid trip over the limit unnoticed.
    if (body.start_date !== undefined || body.end_date !== undefined) {
      const [existing] = await db
        .select({ startDate: trips.startDate, endDate: trips.endDate })
        .from(trips)
        .where(eq(trips.id, tripId))
        .limit(1);
      const nextStart =
        body.start_date !== undefined ? body.start_date : existing?.startDate ?? null;
      const nextEnd =
        body.end_date !== undefined ? body.end_date : existing?.endDate ?? null;
      assertTripDurationWithinLimit(nextStart, nextEnd);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.start_date !== undefined) {
      // start_date_parsed is a hard non-null invariant — never let an edit clear
      // it. Require the new value to parse to a real calendar day.
      const parsed = tryParseToISO(body.start_date);
      if (!parsed) {
        return Response.json(
          { error: 'start_date must be a real date (e.g. "June 3 2026" or "2026-06-03").' },
          { status: 400 },
        );
      }
      update.startDate = body.start_date;
      update.startDateParsed = parsed;
    }
    if (body.end_date !== undefined) {
      update.endDate = body.end_date;
      update.endDateParsed = tryParseToISO(body.end_date);
    }
    if (body.status !== undefined) update.status = body.status;
    if (body.vehicle_id !== undefined) update.vehicleId = body.vehicle_id;
    if (body.prefer_avoid_highways !== undefined)
      update.preferAvoidHighways = body.prefer_avoid_highways;
    if (body.daily_drive_hours !== undefined) update.dailyDriveHours = body.daily_drive_hours;

    await db.update(trips).set(update).where(eq(trips.id, tripId));

    if (body.vehicle_id !== undefined) {
      // Vehicle (and therefore range) changed → existing per-leg fuel plans are
      // stale. Invalidate every leg's lazy cache so each day re-sources on next
      // open, instead of eagerly re-planning the whole trip (the old Places
      // cost sink). userId already authorized via assertTripOwnedByUser above.
      await invalidateTripFuelCache(tripId);
    }

    const [row] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
    return Response.json(row ? rowMappers.tripRow(row) : null);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }

    // Admins can delete any trip (including shared templates). Regular users
    // only get to delete trips they own — asserted by assertTripOwnedByUser.
    const session = await auth();
    const admin = await isAdmin(session?.user?.email);
    if (!admin) {
      await assertTripOwnedByUser(tripId, userId);
    }

    await deleteTrip(tripId);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
