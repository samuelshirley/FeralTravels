import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
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

/** Look up a turn by its client idempotency key (null if unknown). */
export async function getTurnByKey(idempotencyKey: string): Promise<PennyTurn | null> {
  const [row] = await db
    .select()
    .from(pennyTurns)
    .where(eq(pennyTurns.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? toTurn(row) : null;
}

/** Postgres unique-violation SQLSTATE — raised when a 2nd turn races for the
 * trip's single running slot (partial unique index). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * Claim the trip's single execution slot by promoting a specific `queued` turn
 * to `running`. The partial unique index `penny_turns_one_running_per_trip_idx`
 * makes this ATOMIC and race-proof: if another turn already holds the slot, the
 * UPDATE raises a unique violation, which we swallow and return null (the turn
 * stays queued, to be drained later). The status guard also returns null if the
 * turn isn't `queued` (already claimed/done). This is what closes the
 * check-then-insert TOCTOU — two distinct concurrent sends can't both start.
 */
export async function promoteTurnToRunning(id: string): Promise<PennyTurn | null> {
  try {
    const claimed = await db
      .update(pennyTurns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(pennyTurns.id, id), eq(pennyTurns.status, 'queued')))
      .returning();
    return claimed[0] ? toTurn(claimed[0]) : null;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
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
 * Create a turn (always `queued`), deduped on `idempotency_key`. If the key
 * already exists (a retry of the very same send), the existing row is returned
 * untouched — never a second replan for the same send. The caller then tries to
 * `promoteTurnToRunning` to claim the trip's single execution slot; if that
 * fails the turn stays queued and is drained later. Inserting as `queued`
 * (never `running`) keeps the create off the single-running partial index, so
 * only the explicit promotion competes for the slot.
 */
export async function createTurn(input: {
  tripId: string;
  userId: string;
  idempotencyKey: string;
  userMessage: string;
  images?: PennyTurnImage[] | null;
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
      status: 'queued',
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
 * Claim the oldest `queued` turn for a trip, flipping it to `running`. Returns
 * the claimed turn, or null if none is queued (or another writer won the slot).
 * Promotion goes through `promoteTurnToRunning`, so the single-running partial
 * index keeps concurrent drains from ever putting two turns running at once.
 */
export async function claimNextQueuedTurn(tripId: string): Promise<PennyTurn | null> {
  const [candidate] = await db
    .select({ id: pennyTurns.id })
    .from(pennyTurns)
    .where(and(eq(pennyTurns.tripId, tripId), eq(pennyTurns.status, 'queued')))
    .orderBy(asc(pennyTurns.createdAt))
    .limit(1);
  if (!candidate) return null;
  return promoteTurnToRunning(candidate.id);
}
