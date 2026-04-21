import 'server-only';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory } from '@/server/db/schema';
import type { ChatKind, ChatMessage } from '@/types/trip';

function chatRow(r: typeof chatHistory.$inferSelect): ChatMessage {
  return {
    id: r.id,
    trip_id: r.tripId,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    kind: (r.kind as ChatKind) ?? 'ai',
    changes_made: r.changesMade,
    created_at: r.createdAt.toISOString(),
  };
}

export const CHAT_PAGE_SIZE = 50;

/**
 * Returns the full chat history for a trip in ascending order (oldest first).
 * Kept for compatibility; prefer {@link getChatPage} for anything user-facing
 * so we never pay to serialize a multi-thousand-message transcript.
 */
export async function getChatHistory(tripId: number): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatHistory)
    .where(eq(chatHistory.tripId, tripId))
    .orderBy(asc(chatHistory.createdAt));
  return rows.map(chatRow);
}

/**
 * Cursor-paginated chat page. Returns up to `limit` messages that come BEFORE
 * `beforeId` (exclusive) in chronological order, sorted ascending so the UI
 * can just prepend the batch. `hasMore` tells the client whether to keep
 * offering "load older".
 */
export async function getChatPage(params: {
  tripId: number;
  beforeId?: number | null;
  limit?: number;
  /**
   * Restrict to certain chat kinds. Omit to include everything (default). Penny
   * passes `['ai']` so the deterministic onboarding-form rows don't leak into
   * Anthropic's short-term-memory window as if they were conversation.
   */
  kinds?: ChatKind[];
}): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(params.limit ?? CHAT_PAGE_SIZE, 1), 200);
  const conditions = [eq(chatHistory.tripId, params.tripId)];
  if (params.beforeId != null) conditions.push(lt(chatHistory.id, params.beforeId));
  if (params.kinds && params.kinds.length > 0) {
    conditions.push(inArray(chatHistory.kind, params.kinds));
  }

  // Grab `limit + 1` descending to cheaply detect "hasMore", then reverse so
  // the client can prepend without re-sorting.
  const rows = await db
    .select()
    .from(chatHistory)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(chatHistory.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const messages = page.reverse().map(chatRow);
  return { messages, hasMore };
}

export async function addChatMessage(
  tripId: number,
  role: 'user' | 'assistant',
  content: string,
  changesMade?: string | null,
  kind: ChatKind = 'ai'
): Promise<ChatMessage> {
  const [row] = await db
    .insert(chatHistory)
    .values({
      tripId,
      role,
      content,
      changesMade: changesMade ?? null,
      kind,
    })
    .returning();
  return chatRow(row);
}
