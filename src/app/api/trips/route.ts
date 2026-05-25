import { z } from 'zod';
import { requireUserId, errorResponse, HttpError, ConflictError } from '@/server/auth/guards';
import { listTripsForUser, createTrip, generateDefaultTripName } from '@/server/repos/trips';
import { getDefaultVehicleId, getVehicleForUser } from '@/server/repos/vehicles';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await requireUserId();
    const trips = await listTripsForUser(userId);
    return Response.json(trips);
  } catch (err) {
    return errorResponse(err);
  }
}

// `name` is optional: the "+ New trip" button no longer collects one — Penny
// renames the trip to its route during planning. When omitted, the server
// assigns a unique "New trip" placeholder (see generateDefaultTripName).
const createSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  vehicle_id: z.string().uuid().nullish(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await req.json().catch(() => ({})));
    let vehicleId: string | null = body.vehicle_id ?? (await getDefaultVehicleId(userId));

    if (typeof body.vehicle_id === 'string') {
      const v = await getVehicleForUser(userId, body.vehicle_id);
      if (!v) {
        return Response.json({ error: 'Vehicle not found' }, { status: 404 });
      }
      if (!vehicleMeetsFuelPlanningMinimum(v as Record<string, unknown>)) {
        throw new HttpError(
          400,
          'This vehicle needs a refill distance before it can be used on a trip.'
        );
      }
    } else if (vehicleId != null) {
      const v = await getVehicleForUser(userId, vehicleId);
      if (!v || !vehicleMeetsFuelPlanningMinimum(v as Record<string, unknown>)) {
        vehicleId = null;
      }
    }

    // Use the supplied name if there is one; otherwise generate a unique
    // placeholder. Retry the generated-name path on a ConflictError (the rare
    // race where two creates pick the same "New trip N" slot); surface conflicts
    // for an explicitly-supplied name.
    const explicitName =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;

    let trip;
    for (let attempt = 0; ; attempt++) {
      const name = explicitName ?? (await generateDefaultTripName(userId));
      try {
        trip = await createTrip({
          userId,
          name,
          startDate: body.start_date ?? null,
          endDate: body.end_date ?? null,
          vehicleId: vehicleId,
        });
        break;
      } catch (e) {
        if (explicitName || !(e instanceof ConflictError) || attempt >= 4) throw e;
      }
    }
    return Response.json(trip);
  } catch (err) {
    return errorResponse(err);
  }
}
