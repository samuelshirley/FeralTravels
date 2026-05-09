import 'server-only';
import { sql, desc, gte, eq, and, or, ilike, asc, inArray } from 'drizzle-orm';
import { db } from '@/server/db/client';
import {
  users,
  trips,
  legs,
  chatHistory,
  gpxTrails,
  usageEvents,
} from '@/server/db/schema';

export async function getAdminOverview() {
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    [{ totalUsers }],
    [{ totalTrips }],
    [{ totalTemplates }],
    [{ totalLegs }],
    [{ totalChat }],
    [{ totalReplans }],
    [{ totalGpx }],
    [{ newUsers24h }],
    [{ newUsers7d }],
  ] = await Promise.all([
    db.select({ totalUsers: sql<number>`COUNT(*)::int` }).from(users),
    db
      .select({ totalTrips: sql<number>`COUNT(*)::int` })
      .from(trips)
      .where(eq(trips.isTemplate, false)),
    db
      .select({ totalTemplates: sql<number>`COUNT(*)::int` })
      .from(trips)
      .where(eq(trips.isTemplate, true)),
    db.select({ totalLegs: sql<number>`COUNT(*)::int` }).from(legs),
    db.select({ totalChat: sql<number>`COUNT(*)::int` }).from(chatHistory),
    db
      .select({ totalReplans: sql<number>`COUNT(*)::int` })
      .from(chatHistory)
      .where(sql`${chatHistory.role} = 'assistant' AND ${chatHistory.changesMade} IS NOT NULL`),
    db.select({ totalGpx: sql<number>`COUNT(*)::int` }).from(gpxTrails),
    db
      .select({ newUsers24h: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(gte(users.createdAt, since24)),
    db
      .select({ newUsers7d: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(gte(users.createdAt, since7d)),
  ]);

  return {
    totalUsers,
    totalTrips,
    totalTemplates,
    totalLegs,
    totalChat,
    totalReplans,
    totalGpx,
    newUsers24h,
    newUsers7d,
  };
}

export async function getRecentUsers(limit = 25) {
  return db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(limit);
}

export async function getRecentChatActivity(limit = 30) {
  return db
    .select({
      id: chatHistory.id,
      tripId: chatHistory.tripId,
      role: chatHistory.role,
      content: chatHistory.content,
      hasChanges: sql<boolean>`${chatHistory.changesMade} IS NOT NULL`,
      createdAt: chatHistory.createdAt,
    })
    .from(chatHistory)
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);
}

/**
 * Checks whether the Anthropic API has been failing recently.
 * Returns null if healthy, or a summary object if there are failures.
 * Used by the admin dashboard to show a top-of-page alert.
 */
export async function getAnthropicHealthAlert(): Promise<{
  failureCount: number;
  lastError: string | null;
  lastFailedAt: Date | null;
} | null> {
  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({
      errorMessage: usageEvents.errorMessage,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.success, false),
        gte(usageEvents.createdAt, since1h),
        sql`${usageEvents.provider} LIKE 'anthropic%'`
      )
    )
    .orderBy(desc(usageEvents.createdAt))
    .limit(20);

  if (rows.length === 0) return null;

  return {
    failureCount: rows.length,
    lastError: rows[0]?.errorMessage ?? null,
    lastFailedAt: rows[0]?.createdAt ?? null,
  };
}

export async function getRecentErrors(limit = 50) {
  return db
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      provider: usageEvents.provider,
      errorMessage: usageEvents.errorMessage,
      tripId: usageEvents.tripId,
      userId: usageEvents.userId,
      userEmail: users.email,
      userName: users.name,
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.id, usageEvents.userId))
    .where(eq(usageEvents.success, false))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);
}

export async function getTopUsageUsers(hours: number, limit = 25) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return db
    .select({
      userId: usageEvents.userId,
      email: users.email,
      name: users.name,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.id, usageEvents.userId))
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.userId, users.email, users.name)
    .orderBy(desc(sql`SUM(${usageEvents.costMicrocents})`))
    .limit(limit);
}

/**
 * All-time top spenders, joined to trip count for an avg-cost-per-trip
 * calculation. Drives the "who's actually expensive" view on /admin.
 *
 * The trip count comes from a correlated subquery rather than a join +
 * GROUP BY because joining trips would multiply usage rows by trip count
 * (each user's usage gets duplicated per trip they own) and inflate the
 * spend totals. The subquery keeps the spend math correct.
 *
 * `lastSeenAt` is the most recent usage row, so you can spot dormant
 * heavy spenders vs currently-active ones at a glance.
 *
 * Filtered to provider='anthropic' because Google Places spend in our DB
 * is an estimate that the $200/mo free credit usually zeros out — mixing
 * it into a "user cost" view would mislead.
 */
export async function getTopUsersAllTime(limit = 25) {
  // IMPORTANT: pass an ISO string, not a Date, when interpolating into a raw
  // sql`` template. The drizzle helpers like gte(col, date) carry the
  // column's pg type, but template-interpolated values do not — postgres-js
  // falls back to its text encoder and tries Buffer.byteLength on the value.
  // Buffer.byteLength on a Date throws ERR_INVALID_ARG_TYPE → the whole
  // /admin page 500s with a server-side digest. Caused outage 2026-05-09.
  // PostgreSQL implicit-casts ISO 8601 strings to timestamp in comparisons,
  // so this is functionally identical to a Date param via gte().
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .select({
      userId: usageEvents.userId,
      email: users.email,
      name: users.name,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
      // Same row, narrower predicate via FILTER — gives us per-user 7d spend
      // alongside the all-time total without a second query or join.
      microcents7d: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}) FILTER (WHERE ${usageEvents.createdAt} >= ${since7d}), 0)::bigint`,
      tripCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${trips}
        WHERE ${trips.userId} = ${usageEvents.userId}
          AND ${trips.isTemplate} = false
      )`,
      lastSeenAt: sql<Date>`MAX(${usageEvents.createdAt})`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.id, usageEvents.userId))
    .where(eq(usageEvents.provider, 'anthropic'))
    .groupBy(usageEvents.userId, users.email, users.name)
    .orderBy(desc(sql`SUM(${usageEvents.costMicrocents})`))
    .limit(limit);
}

/**
 * Aggregate spend by provider over a time window. Used by the dashboard
 * to surface Anthropic vs Google estimates side-by-side, with a note
 * that Google figures are estimates (free-tier credits typically zero
 * the actual bill).
 */
export async function getProviderTotals(hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return db
    .select({
      provider: usageEvents.provider,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(usageEvents.provider);
}

/**
 * All-time Anthropic spend total. Single number for the headline stat
 * card so the dashboard isn't only showing 24h/7d windows.
 */
export async function getAllTimeAnthropicSpend(): Promise<{
  microcents: number;
  requests: number;
  firstSeen: Date | null;
}> {
  const rows = await db
    .select({
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      firstSeen: sql<Date | null>`MIN(${usageEvents.createdAt})`,
    })
    .from(usageEvents)
    .where(eq(usageEvents.provider, 'anthropic'));
  return rows[0] ?? { microcents: 0, requests: 0, firstSeen: null };
}

// ============================================================================
// Drill-in helpers — used by /admin/users, /admin/users/[id], /admin/errors,
// /admin/chats/[tripId]. All return raw rows; Date conversion + serialization
// happens in the page component.
// ============================================================================

export type UserSort = 'joined_desc' | 'joined_asc' | 'name_asc' | 'name_desc';

export async function listAllUsers(opts: {
  offset?: number;
  limit?: number;
  search?: string | null;
  sort?: UserSort;
}) {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const search = opts.search?.trim() || null;
  const sort: UserSort = opts.sort ?? 'joined_desc';

  const where = search
    ? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`))
    : undefined;

  const orderBy =
    sort === 'joined_asc'
      ? asc(users.createdAt)
      : sort === 'name_asc'
        ? asc(users.name)
        : sort === 'name_desc'
          ? desc(users.name)
          : desc(users.createdAt);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where)
      .orderBy(orderBy)
      .offset(offset)
      .limit(limit),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(where),
  ]);

  return { rows, total, offset, limit };
}

/**
 * Per-user detail used by /admin/users/[id]: the user row, their trips,
 * lifetime + 7d AI spend (Anthropic-only — same accounting as the dashboard
 * `Top spenders` cards), recent errors and recent chat scoped to this user.
 */
export async function getUserDetail(userId: string) {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    [user],
    userTrips,
    [{ lifetimeMicrocents, lifetimeRequests }],
    [{ microcents7d, requests7d }],
    recentErrorsForUser,
    recentChatForUser,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        createdAt: users.createdAt,
        isAdmin: users.isAdmin,
        unitsPref: users.unitsPref,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({
        id: trips.id,
        name: trips.name,
        status: trips.status,
        isTemplate: trips.isTemplate,
        startDate: trips.startDate,
        endDate: trips.endDate,
        createdAt: trips.createdAt,
        updatedAt: trips.updatedAt,
      })
      .from(trips)
      .where(eq(trips.userId, userId))
      .orderBy(desc(trips.updatedAt)),
    db
      .select({
        lifetimeMicrocents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
        lifetimeRequests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          eq(usageEvents.provider, 'anthropic'),
          eq(usageEvents.success, true)
        )
      ),
    db
      .select({
        microcents7d: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
        requests7d: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          eq(usageEvents.provider, 'anthropic'),
          eq(usageEvents.success, true),
          gte(usageEvents.createdAt, since7d)
        )
      ),
    db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        provider: usageEvents.provider,
        errorMessage: usageEvents.errorMessage,
        tripId: usageEvents.tripId,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), eq(usageEvents.success, false)))
      .orderBy(desc(usageEvents.createdAt))
      .limit(20),
    db
      .select({
        id: chatHistory.id,
        tripId: chatHistory.tripId,
        tripName: trips.name,
        role: chatHistory.role,
        content: chatHistory.content,
        hasChanges: sql<boolean>`${chatHistory.changesMade} IS NOT NULL`,
        createdAt: chatHistory.createdAt,
      })
      .from(chatHistory)
      .innerJoin(trips, eq(trips.id, chatHistory.tripId))
      .where(eq(trips.userId, userId))
      .orderBy(desc(chatHistory.createdAt))
      .limit(20),
  ]);

  if (!user) return null;

  return {
    user,
    trips: userTrips,
    spend: {
      lifetimeMicrocents,
      lifetimeRequests,
      microcents7d,
      requests7d,
    },
    recentErrors: recentErrorsForUser,
    recentChat: recentChatForUser,
  };
}

export interface ListErrorsParams {
  offset?: number;
  limit?: number;
  /** Provider exact-match filter (multi). Empty/undefined = all providers. */
  providers?: string[] | null;
  /** Restrict to a specific user. */
  userId?: string | null;
  /** Free-text ilike on errorMessage. */
  search?: string | null;
  /** Lower bound on createdAt. */
  since?: Date | null;
}

export async function listErrors(opts: ListErrorsParams) {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));

  const conditions = [eq(usageEvents.success, false)];
  if (opts.providers && opts.providers.length > 0) {
    conditions.push(inArray(usageEvents.provider, opts.providers));
  }
  if (opts.userId) {
    conditions.push(eq(usageEvents.userId, opts.userId));
  }
  if (opts.search) {
    conditions.push(ilike(usageEvents.errorMessage, `%${opts.search.trim()}%`));
  }
  if (opts.since) {
    conditions.push(gte(usageEvents.createdAt, opts.since));
  }
  const where = and(...conditions);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        provider: usageEvents.provider,
        errorMessage: usageEvents.errorMessage,
        tripId: usageEvents.tripId,
        userId: usageEvents.userId,
        userEmail: users.email,
        userName: users.name,
      })
      .from(usageEvents)
      .leftJoin(users, eq(users.id, usageEvents.userId))
      .where(where)
      .orderBy(desc(usageEvents.createdAt))
      .offset(offset)
      .limit(limit),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(usageEvents)
      .where(where),
  ]);

  return { rows, total, offset, limit };
}

/** Distinct providers seen in failed usage events — used to populate the
 *  /admin/errors filter dropdown. */
export async function listErrorProviders(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ provider: usageEvents.provider })
    .from(usageEvents)
    .where(eq(usageEvents.success, false))
    .orderBy(asc(usageEvents.provider));
  return rows.map((r) => r.provider);
}

/**
 * Full chat history for a single trip plus the trip's owner — used by
 * /admin/chats/[tripId] for read-only conversation review. Returns NULL if
 * the trip doesn't exist so the page can 404.
 */
export async function getChatForTrip(tripId: number) {
  const [trip] = await db
    .select({
      id: trips.id,
      name: trips.name,
      status: trips.status,
      isTemplate: trips.isTemplate,
      startDate: trips.startDate,
      endDate: trips.endDate,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
      userId: trips.userId,
      userEmail: users.email,
      userName: users.name,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.userId))
    .where(eq(trips.id, tripId))
    .limit(1);

  if (!trip) return null;

  const messages = await db
    .select({
      id: chatHistory.id,
      role: chatHistory.role,
      content: chatHistory.content,
      kind: chatHistory.kind,
      changesMade: chatHistory.changesMade,
      createdAt: chatHistory.createdAt,
    })
    .from(chatHistory)
    .where(eq(chatHistory.tripId, tripId))
    .orderBy(asc(chatHistory.createdAt));

  return { trip, messages };
}
