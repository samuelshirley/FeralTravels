import { z } from 'zod';
import { requireUserId, errorResponse, HttpError } from '@/server/auth/guards';
import { listTripsForUser, createTrip } from '@/server/repos/trips';
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

const createSchema = z.object({
  name: z.string().min(1).max(200),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  vehicle_id: z.string().uuid().nullish(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await req.json());
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

    const trip = await createTrip({
      userId,
      name: body.name,
      startDate: body.start_date ?? null,
      endDate: body.end_date ?? null,
      vehicleId: vehicleId,
    });
    return Response.json(trip);
  } catch (err) {
    return errorResponse(err);
  }
}
