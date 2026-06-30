import { z } from 'zod';
import { requireUserId, assertTripOwnedByUser, errorResponse } from '@/server/auth/guards';
import { parseUUID } from '@/lib/validation';
import { getTurnByKey, getLatestTurnForTrip } from '@/server/repos/pennyTurns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turn reconcile endpoint — the client's way to re-attach after the chat stream
 * drops (PWA backgrounded mid-turn) or after firing a turn that was QUEUED
 * behind another. See docs/design/penny-turn-resilience.md.
 *
 * `GET /api/trips/[id]/turns?key=<idempotencyKey>` returns that specific turn
 * (the one the client just sent), so it can heal the false "Something went
 * wrong" bubble or poll a queued turn to completion.
 *
 * `GET /api/trips/[id]/turns` (no key) returns the most recent turn for the
 * trip — used to reconcile on reopen when the client doesn't know the key.
 *
 * Read-only; never mutates trip state. The locked contract: the only accepted
 * input is the (optional) `key` query param, validated below. A turn is only
 * returned when it belongs to THIS trip (ownership already checked), so a key
 * can't be used to read another trip's turn.
 */
const querySchema = z.object({
  key: z.string().min(8).max(100).optional(),
});

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const tripId = parseUUID(ctx.params.id);
    if (!tripId) {
      return Response.json({ error: 'Invalid trip id' }, { status: 400 });
    }
    await assertTripOwnedByUser(tripId, userId);

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({ key: url.searchParams.get('key') ?? undefined });
    if (!parsed.success) {
      return Response.json({ error: 'Invalid query' }, { status: 400 });
    }
    const { key } = parsed.data;

    const turn = key ? await getTurnByKey(key) : await getLatestTurnForTrip(tripId);

    // Guard cross-trip key reads: a turn from a different trip (or none) reads
    // as not-found rather than leaking another trip's record.
    if (!turn || turn.trip_id !== tripId) {
      return Response.json({ turn: null });
    }

    return Response.json({ turn });
  } catch (err) {
    return errorResponse(err);
  }
}
