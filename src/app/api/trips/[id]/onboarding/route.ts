import { z } from 'zod';
import {
  requireUserId,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getOnboardingSnapshot, submitAnswer } from '@/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseId(ctx.params.id);
    if (tripId == null) return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    await assertTripOwnedByUser(tripId, userId);
    const snapshot = await getOnboardingSnapshot(tripId, userId);
    return Response.json(snapshot);
  } catch (err) {
    return errorResponse(err);
  }
}

const answerSchema = z.object({
  // questionKey can be any string; the server validates it against current state.
  questionKey: z.string().min(1).max(60),
  // Accept strings, numbers, or null (for optional skip). Everything else is
  // coerced server-side; no need to over-constrain here.
  value: z.union([z.string(), z.number(), z.null()]),
});

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseId(ctx.params.id);
    if (tripId == null) return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    await assertTripOwnedByUser(tripId, userId);
    const body = answerSchema.parse(await req.json());
    const result = await submitAnswer(tripId, userId, body);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
