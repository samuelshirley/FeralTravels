import { z } from 'zod';
import {
  requireUserId,
  assertTripReadableByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getChatPage, CHAT_PAGE_SIZE } from '@/server/repos/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  tripId: z.coerce.number().int().positive(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/**
 * Cursor-paginated chat history.
 *
 *   GET /api/chat?tripId=123                → last 50 messages (ascending)
 *   GET /api/chat?tripId=123&before=987     → 50 messages older than id 987
 *
 * Response: { messages: ChatMessage[], hasMore: boolean }
 *
 * Templates are readable by any authenticated user (they don't own them but
 * may be viewing a demo), so we use {@link assertTripReadableByUser} here.
 */
export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const q = querySchema.parse({
      tripId: url.searchParams.get('tripId'),
      before: url.searchParams.get('before') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });

    await assertTripReadableByUser(q.tripId, userId);

    const { messages, hasMore } = await getChatPage({
      tripId: q.tripId,
      beforeId: q.before ?? null,
      limit: q.limit ?? CHAT_PAGE_SIZE,
    });
    return Response.json({ messages, hasMore });
  } catch (err) {
    return errorResponse(err);
  }
}
