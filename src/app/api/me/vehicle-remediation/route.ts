import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import {
  getVehicleRemediationSnapshot,
  submitVehicleRemediationAnswer,
} from '@/server/vehicleRemediation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const postSchema = z.object({
  questionKey: z.string().min(1),
  value: z.unknown(),
});

export async function GET() {
  try {
    const userId = await requireUserId();
    const snapshot = await getVehicleRemediationSnapshot(userId);
    return Response.json(snapshot);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const json: unknown = await req.json();
    const { questionKey, value } = postSchema.parse(json);
    const snapshot = await submitVehicleRemediationAnswer(userId, questionKey, value);
    return Response.json(snapshot);
  } catch (err) {
    return errorResponse(err);
  }
}
