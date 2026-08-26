import { z } from 'zod';
import {
  requireUserId,
  requireEntitledUser,
  assertTripOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getOnboardingSnapshot, submitAnswer } from '@/server/onboarding';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) return Response.json({ error: 'Invalid trip id' }, { status: 400 });
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
    // The forgotten spender. `submitAnswer` runs the intent scan, the start-date
    // parser and the comfortable-range estimator — three Anthropic calls that
    // had no cap of any kind before this. The GET above stays ungated: reading
    // the snapshot costs nothing and is how the paywall bubble gets drawn.
    const { id: userId } = await requireEntitledUser();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    await assertTripOwnedByUser(tripId, userId);
    const body = answerSchema.parse(await req.json());
    const result = await submitAnswer(tripId, userId, body);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
