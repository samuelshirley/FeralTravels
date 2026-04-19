import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory } from '@/server/db/schema';
import type { ChatMessage } from '@/types/trip';

function chatRow(r: typeof chatHistory.$inferSelect): ChatMessage {
  return {
    id: r.id,
    trip_id: r.tripId,
    role: r.role as 'user' | 'assistant',
    content: r.content,
    changes_made: r.changesMade,
    created_at: r.createdAt.toISOString(),
  };
}

export async function getChatHistory(tripId: number): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatHistory)
    .where(eq(chatHistory.tripId, tripId))
    .orderBy(asc(chatHistory.createdAt));
  return rows.map(chatRow);
}

export async function addChatMessage(
  tripId: number,
  role: 'user' | 'assistant',
  content: string,
  changesMade?: string | null
): Promise<void> {
  await db.insert(chatHistory).values({
    tripId,
    role,
    content,
    changesMade: changesMade ?? null,
  });
}
