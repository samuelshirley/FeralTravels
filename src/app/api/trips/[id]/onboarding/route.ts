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
  /*
   * Strings, numbers, null (an optional skip) — and ONE closed object shape,
   * for the composite vehicle card that answers a nickname and a range
   * together.
   *
   * The object is spelled out rather than allowed as `z.record(z.unknown())`,
   * because "accept an object here" is how a locked-down endpoint stops being
   * one. `.strict()` rejects an unexpected key instead of ignoring it, and
   * `range_km` stays a union because "I don't know" is a legitimate answer to
   * it that routes to the estimator. `submitAnswer` re-validates all of it —
   * name non-empty, range numeric and inside the vehicle bounds — so this is
   * the shape of the payload, never the authority on its contents.
   */
  value: z.union([
    z.string(),
    z.number(),
    z.null(),
    z
      .object({
        name: z.string(),
        range_km: z.union([z.string(), z.number()]),
      })
      .strict(),
  ]),
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
