import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { pennyTurns, type PennyTurnStatus } from '@/server/db/schema';

export type PennyTurnImage = { dataUrl: string; mediaType: string };

/** Serializable turn shape shared by the route and the client reconcile flow. */
export interface PennyTurn {
  id: string;
  trip_id: string;
  user_id: string;
  idempotency_key: string;
  status: PennyTurnStatus;
  user_message: string;
  images: PennyTurnImage[] | null;
  result_response: string | null;
  result_meta: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function toTurn(r: typeof pennyTurns.$inferSelect): PennyTurn {
  return {
    id: r.id,
    trip_id: r.tripId,
    user_id: r.userId,
    idempotency_key: r.idempotencyKey,
    status: r.status,
    user_message: r.userMessage,
    images: r.images ?? null,
    result_response: r.resultResponse ?? null,
    result_meta: r.resultMeta ?? null,
    error_message: r.errorMessage ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/** Statuses that mean a turn is occupying the trip's single execution slot. */
const ACTIVE_STATUSES: PennyTurnStatus[] = ['running', 'queued'];

/** Look up a turn by its client idempotency key (null if unknown). */
export async function getTurnByKey(idempotencyKey: string): Promise<PennyTurn | null> {
  const [row] = await db
    .select()
    .from(pennyTurns)
    .where(eq(pennyTurns.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? toTurn(row) : null;
}

/** The oldest still-active (`running` then `queued`) turn for a trip, if any. */
export async function getActiveTurnForTrip(tripId: string): Promise<PennyTurn | null> {
  const [row] = await db
    .select()
    .from(pennyTurns)
    .where(and(eq(pennyTurns.tripId, tripId), inArray(pennyTurns.status, ACTIVE_STATUSES)))
    .orderBy(asc(pennyTurns.createdAt))
    .limit(1);
  return row ? toTurn(row) : null;
}

/** Most recent turn for a trip (used by the client to reconcile on reopen). */
export async function getLatestTurnForTrip(tripId: string): Promise<PennyTurn | null> {
  const [row] = await db
    .select()
    .from(pennyTurns)
    .where(eq(pennyTurns.tripId, tripId))
    .orderBy(desc(pennyTurns.createdAt))
    .limit(1);
  return row ? toTurn(row) : null;
}

/**
 * Create a turn, deduped on `idempotency_key`. If the key already exists (a retry
 * of the very same send), the existing row is returned untouched — never a second
 * concurrent replan. Caller decides `status`: `running` when it will execute now,
 * `queued` when another turn is already active on the trip.
 */
export async function createTurn(input: {
  tripId: string;
  userId: string;
  idempotencyKey: string;
  userMessage: string;
  images?: PennyTurnImage[] | null;
  status: Extract<PennyTurnStatus, 'running' | 'queued'>;
}): Promise<{ turn: PennyTurn; created: boolean }> {
  const existing = await getTurnByKey(input.idempotencyKey);
  if (existing) return { turn: existing, created: false };

  const inserted = await db
    .insert(pennyTurns)
    .values({
      tripId: input.tripId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      userMessage: input.userMessage,
      images: input.images ?? null,
      status: input.status,
    })
    // Unique index on idempotency_key: if a racing request inserted first, do
    // nothing and we re-read below — guarantees exactly one row per key.
    .onConflictDoNothing({ target: pennyTurns.idempotencyKey })
    .returning();

  if (inserted[0]) return { turn: toTurn(inserted[0]), created: true };

  const row = await getTurnByKey(input.idempotencyKey);
  if (!row) throw new Error('createTurn: row vanished after conflict');
  return { turn: row, created: false };
}

export async function markTurnDone(
  id: string,
  result: { resultResponse: string; resultMeta?: Record<string, unknown> | null }
): Promise<void> {
  await db
    .update(pennyTurns)
    .set({
      status: 'done',
      resultResponse: result.resultResponse,
      resultMeta: result.resultMeta ?? null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(pennyTurns.id, id));
}

export async function markTurnError(id: string, errorMessage: string): Promise<void> {
  await db
    .update(pennyTurns)
    .set({ status: 'error', errorMessage: errorMessage.slice(0, 1000), updatedAt: new Date() })
    .where(eq(pennyTurns.id, id));
}

/**
 * Atomically claim the oldest `queued` turn for a trip, flipping it to `running`.
 * Returns the claimed turn, or null if none is queued. The status guard in the
 * WHERE makes the claim safe under concurrent drains: only one writer wins the
 * flip, the loser sees no row returned.
 */
export async function claimNextQueuedTurn(tripId: string): Promise<PennyTurn | null> {
  const [candidate] = await db
    .select({ id: pennyTurns.id })
    .from(pennyTurns)
    .where(and(eq(pennyTurns.tripId, tripId), eq(pennyTurns.status, 'queued')))
    .orderBy(asc(pennyTurns.createdAt))
    .limit(1);
  if (!candidate) return null;

  const claimed = await db
    .update(pennyTurns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(pennyTurns.id, candidate.id), eq(pennyTurns.status, 'queued')))
    .returning();

  return claimed[0] ? toTurn(claimed[0]) : null;
}
