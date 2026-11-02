import {
  ConflictError,
  NotFoundError,
  requireUserId,
  errorResponse,
} from '@/server/auth/guards';
import { setVote } from '@/server/repos/featureRequests';
import { parseUUID } from '@/lib/validation';
import { VOTING_CLOSED_CODE } from '@/lib/featureRequests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT casts this user's vote; DELETE withdraws it. Both are idempotent and
 * answer `{ voteCount, votedByMe }`.
 *
 * Two verbs rather than one "toggle": a toggle retried on a flaky connection
 * flips the vote back, while a retried PUT or DELETE lands where it was meant
 * to. The one-vote rule itself is the table's primary key, not this route.
 */
async function handle(ctx: { params: { id: string } }, vote: boolean): Promise<Response> {
  try {
    const userId = await requireUserId();
    const id = parseUUID(ctx.params.id);
    if (!id) throw new NotFoundError('not_found');
    const outcome = await setVote(userId, id, vote);
    if (!outcome.ok) {
      if (outcome.reason === 'voting_closed') throw new ConflictError(VOTING_CLOSED_CODE);
      throw new NotFoundError('not_found');
    }
    return Response.json({ voteCount: outcome.voteCount, votedByMe: outcome.votedByMe });
  } catch (err) {
    return errorResponse(err);
  }
}

export function PUT(_req: Request, ctx: { params: { id: string } }) {
  return handle(ctx, true);
}

export function DELETE(_req: Request, ctx: { params: { id: string } }) {
  return handle(ctx, false);
}
