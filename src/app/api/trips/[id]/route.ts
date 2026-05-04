import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { trips, vehicles } from '@/server/db/schema';
import {
  requireUserId,
  assertTripOwnedByUser,
  isAdmin,
  errorResponse,
} from '@/server/auth/guards';
import { auth } from '@/server/auth';
import { deleteTrip, assertTripNameAvailable } from '@/server/repos/trips';
import { rowMappers } from '@/server/repos/trips';
import { replenishFuelStopsForTrip } from '@/server/fuel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  status: z.string().max(40).optional(),
  // null = explicitly clear; number = set to a vehicle the user owns.
  vehicle_id: z.number().int().positive().nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(tripId)) {
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
    if (typeof body.vehicle_id === 'number') {
      const owned = await db
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(and(eq(vehicles.userId, userId), eq(vehicles.id, body.vehicle_id)))
        .limit(1);
      if (owned.length === 0) {
        return Response.json({ error: 'Vehicle not found' }, { status: 404 });
      }
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.start_date !== undefined) update.startDate = body.start_date;
    if (body.end_date !== undefined) update.endDate = body.end_date;
    if (body.status !== undefined) update.status = body.status;
    if (body.vehicle_id !== undefined) update.vehicleId = body.vehicle_id;

    await db.update(trips).set(update).where(eq(trips.id, tripId));

    if (body.vehicle_id !== undefined) {
      await replenishFuelStopsForTrip(tripId, userId);
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
    const tripId = parseInt(ctx.params.id, 10);
    if (Number.isNaN(tripId)) {
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
