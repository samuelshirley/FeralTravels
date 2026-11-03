import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { featureRequests, featureRequestVotes } from '@/server/db/schema';
import {
  compareFeatureRequests,
  votingOpen,
  type FeatureRequestStatus,
  type FeatureRequestView,
  type VoteResult,
} from '@/lib/featureRequests';

/**
 * Feature requests and their votes. The admin writes requests; users vote.
 *
 * The one-vote rule is the vote table's primary key, not anything in here:
 * a vote is `INSERT … ON CONFLICT DO NOTHING`, so a retry, a double tap or a
 * second device all land on the same single row. Counts are always counted
 * from the rows, never stored.
 */

const voteCount = sql<number>`(
  SELECT COUNT(*)::int FROM feature_request_votes v
  WHERE v.request_id = ${featureRequests.id}
)`;

function toView(row: {
  id: string;
  title: string;
  body: string | null;
  status: FeatureRequestStatus;
  reply: string | null;
  voteCount: number;
  votedByMe: boolean;
  createdAt: Date;
}): FeatureRequestView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    reply: row.reply,
    voteCount: Number(row.voteCount),
    votedByMe: Boolean(row.votedByMe),
    createdAt: row.createdAt.toISOString(),
  };
}

// ── User-facing ─────────────────────────────────────────────────────────────

/** Every request, with its count and whether this user has voted, in display order. */
export async function listFeatureRequestsForUser(userId: string): Promise<FeatureRequestView[]> {
  const rows = await db
    .select({
      id: featureRequests.id,
      title: featureRequests.title,
      body: featureRequests.body,
      status: featureRequests.status,
      reply: featureRequests.reply,
      createdAt: featureRequests.createdAt,
      voteCount,
      votedByMe: sql<boolean>`EXISTS (
        SELECT 1 FROM feature_request_votes v
        WHERE v.request_id = ${featureRequests.id} AND v.user_id = ${userId}
      )`,
    })
    .from(featureRequests);
  return rows.map(toView).sort(compareFeatureRequests);
}

export type VoteOutcome =
  | ({ ok: true } & VoteResult)
  | { ok: false; reason: 'not_found' | 'voting_closed' };

async function voteState(userId: string, requestId: string) {
  const [row] = await db
    .select({
      status: featureRequests.status,
      voteCount,
      votedByMe: sql<boolean>`EXISTS (
        SELECT 1 FROM feature_request_votes v
        WHERE v.request_id = ${featureRequests.id} AND v.user_id = ${userId}
      )`,
    })
    .from(featureRequests)
    .where(eq(featureRequests.id, requestId))
    .limit(1);
  return row ?? null;
}

/**
 * Cast or withdraw this user's vote. Idempotent both ways.
 *
 * The write and the "is voting open" check are ONE statement: the insert
 * selects the request row only while it is not `not_doing`, so a request the
 * admin closes mid-tap cannot take a vote between a check and a write.
 */
export async function setVote(userId: string, requestId: string, vote: boolean): Promise<VoteOutcome> {
  if (vote) {
    await db
      .insert(featureRequestVotes)
      .select(
        db
          .select({
            userId: sql<string>`${userId}`.as('user_id'),
            requestId: featureRequests.id,
            createdAt: sql<Date>`now()`.as('created_at'),
          })
          .from(featureRequests)
          .where(and(eq(featureRequests.id, requestId), ne(featureRequests.status, 'not_doing'))),
      )
      .onConflictDoNothing();
  } else {
    await db
      .delete(featureRequestVotes)
      .where(
        and(
          eq(featureRequestVotes.userId, userId),
          eq(featureRequestVotes.requestId, requestId),
          sql`EXISTS (
            SELECT 1 FROM feature_requests r
            WHERE r.id = ${requestId} AND r.status <> 'not_doing'
          )`,
        ),
      );
  }

  const state = await voteState(userId, requestId);
  if (!state) return { ok: false, reason: 'not_found' };
  if (!votingOpen(state.status)) return { ok: false, reason: 'voting_closed' };
  return { ok: true, voteCount: Number(state.voteCount), votedByMe: Boolean(state.votedByMe) };
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface AdminFeatureRequest extends Omit<FeatureRequestView, 'votedByMe'> {
  updatedAt: string;
}

/** Every request with its count, in the same order the app shows them. */
export async function listFeatureRequestsForAdmin(): Promise<AdminFeatureRequest[]> {
  const rows = await db
    .select({
      id: featureRequests.id,
      title: featureRequests.title,
      body: featureRequests.body,
      status: featureRequests.status,
      reply: featureRequests.reply,
      createdAt: featureRequests.createdAt,
      updatedAt: featureRequests.updatedAt,
      voteCount,
    })
    .from(featureRequests);
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      status: r.status,
      reply: r.reply,
      voteCount: Number(r.voteCount),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    .sort(compareFeatureRequests);
}

export async function createFeatureRequest(data: { title: string; body?: string | null }) {
  const [row] = await db
    .insert(featureRequests)
    .values({ title: data.title, body: data.body ?? null })
    .returning({ id: featureRequests.id });
  return row;
}

export interface FeatureRequestPatch {
  title?: string;
  body?: string | null;
  status?: FeatureRequestStatus;
  reply?: string | null;
}

/** Returns false when no request has this id. */
export async function updateFeatureRequest(id: string, patch: FeatureRequestPatch): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(featureRequests)
    .set({
      ...patch,
      ...(patch.reply !== undefined ? { replyUpdatedAt: patch.reply === null ? null : now } : {}),
      updatedAt: now,
    })
    .where(eq(featureRequests.id, id))
    .returning({ id: featureRequests.id });
  return rows.length > 0;
}

/** Deletes the request and, by cascade, every vote on it. False when no such id. */
export async function deleteFeatureRequest(id: string): Promise<boolean> {
  const rows = await db
    .delete(featureRequests)
    .where(eq(featureRequests.id, id))
    .returning({ id: featureRequests.id });
  return rows.length > 0;
}

/** The /admin stat card: requests per status, and votes on the ones still open to voting. */
export async function getFeatureRequestStats() {
  const [row] = await db
    .select({
      open: sql<number>`COUNT(*) FILTER (WHERE ${featureRequests.status} = 'open')::int`,
      inProgress: sql<number>`COUNT(*) FILTER (WHERE ${featureRequests.status} = 'in_progress')::int`,
      notDoing: sql<number>`COUNT(*) FILTER (WHERE ${featureRequests.status} = 'not_doing')::int`,
      votes: sql<number>`COALESCE(SUM(${voteCount}) FILTER (WHERE ${featureRequests.status} <> 'not_doing'), 0)::int`,
    })
    .from(featureRequests);
  return {
    open: Number(row?.open ?? 0),
    inProgress: Number(row?.inProgress ?? 0),
    notDoing: Number(row?.notDoing ?? 0),
    votes: Number(row?.votes ?? 0),
  };
}
