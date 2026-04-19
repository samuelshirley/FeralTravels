import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { listTripsForUser, createTrip } from '@/server/repos/trips';
import { getDefaultVehicleId } from '@/server/repos/vehicles';

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
  vehicle_id: z.number().int().positive().nullish(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const body = createSchema.parse(await req.json());
    const vehicleId = body.vehicle_id ?? (await getDefaultVehicleId(userId));
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
