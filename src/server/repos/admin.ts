import 'server-only';
import { sql, desc, gte, eq, and, or, ilike, asc, inArray } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { INTERNAL_EMAIL_PATTERNS } from '@/lib/internalAccounts';
import { statusClassPattern, type HttpStatusClass } from '@/lib/httpStatusClass';
import {
  users,
  trips,
  legs,
  chatHistory,
  usageEvents,
  userViewportTime,
  vehicles,
  deletedUsers,
  subscriptionEvents,
} from '@/server/db/schema';

/**
 * `users` rows that are ours — the test accounts we mint, and the owner's own
 * dated signups. See `internalAccounts.ts` for the patterns and for why every
 * one of them is tight rather than a wildcard.
 *
 * `~*` is Postgres's case-insensitive regex operator. It is used instead of
 * ILIKE because LIKE has no character classes, and the owner's pattern has to
 * say "digits and dots" — `samuelashirley+<anything>@gmail.com` is an address
 * a stranger can sign up with, and a wildcard would hide them.
 *
 * Only the user-COUNT cards use this. The user list, the top-spender table and
 * every spend figure stay unfiltered: a fixture that spent $7 still spent $7,
 * and the list is where you go to find and delete these rows.
 */
const isInternalUser = or(
  ...INTERNAL_EMAIL_PATTERNS.map((pattern) => sql`${users.email} ~* ${pattern}`)
)!;
const isRealUser = sql`NOT (${isInternalUser})`;

const toDateOrNull = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v));

/**
 * A user's last sign of life: the newest of their usage row (every Penny turn
 * and every paid Google call writes one), their trip edits, and the web
 * viewport heartbeat. There is no `last_seen` column; this reads the rows the
 * app already writes. Correlated on the OUTER `users` row, so it only works in
 * a query whose FROM is `users`. GREATEST ignores NULLs, so a user with no
 * activity at all is NULL, not the epoch.
 */
// Qualified by hand: drizzle renders `${users.id}` as a bare "id", which
// inside these subqueries binds to the INNER table's uuid id (measured:
// `operator does not exist: text = uuid` on the first PGlite run).
const OUTER_USER_ID = sql.raw('"users"."id"');
const lastActiveAtSql = sql`GREATEST(
  (SELECT MAX(ue.created_at) FROM usage_events ue WHERE ue.user_id = ${OUTER_USER_ID}),
  (SELECT MAX(t.updated_at) FROM trips t WHERE t.user_id = ${OUTER_USER_ID}),
  (SELECT MAX(v.updated_at) FROM user_viewport_time v WHERE v.user_id = ${OUTER_USER_ID})
)`;
const lastActiveAt = sql<Date | null>`${lastActiveAtSql}`.mapWith(toDateOrNull);
const tripCountSql = sql<number>`(SELECT COUNT(*)::int FROM trips t WHERE t.user_id = ${OUTER_USER_ID} AND t.is_template = false)`.mapWith(Number);
/** Anthropic list-price estimate, same accounting as the old Top spenders table. */
const spendMicrocentsSql = sql<number>`(SELECT COALESCE(SUM(ue.cost_microcents), 0)::bigint FROM usage_events ue WHERE ue.user_id = ${OUTER_USER_ID} AND ue.provider = 'anthropic')`.mapWith(Number);
const errorCountSql = sql<number>`(SELECT COUNT(*)::int FROM usage_events ue WHERE ue.user_id = ${OUTER_USER_ID} AND ue.success = false)`.mapWith(Number);

/** Error-message predicates for a status class. 5xx wins a message that has both. */
function statusClassWhere(cls: HttpStatusClass) {
  const is4 = sql`${usageEvents.errorMessage} ~* ${statusClassPattern('4')}`;
  const is5 = sql`${usageEvents.errorMessage} ~* ${statusClassPattern('5')}`;
  if (cls === '5xx') return sql`COALESCE(${is5}, false)`;
  if (cls === '4xx') return sql`COALESCE(${is4} AND NOT ${is5}, false)`;
  return sql`NOT COALESCE(${is4} OR ${is5}, false)`;
}

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
    [{ totalVehicles }],
    [{ newUsers24h }],
    [{ newUsers7d }],
    [{ totalDeletedUsers }],
    [{ internalUsers }],
    [{ activeUsers24h, activeUsers7d }],
  ] = await Promise.all([
    db.select({ totalUsers: sql<number>`COUNT(*)::int` }).from(users).where(isRealUser),
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
    db.select({ totalVehicles: sql<number>`COUNT(*)::int` }).from(vehicles),
    db
      .select({ newUsers24h: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(and(isRealUser, gte(users.createdAt, since24))),
    db
      .select({ newUsers7d: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(and(isRealUser, gte(users.createdAt, since7d))),
    // Tombstones, not live users — `totalUsers` above counts who is still here,
    // this counts who left. Both matter and neither implies the other.
    db.select({ totalDeletedUsers: sql<number>`COUNT(*)::int` }).from(deletedUsers),
    // Counted and SHOWN, not silently dropped. If this number ever jumps, a
    // pattern in `internalAccounts.ts` is matching real signups — which is the
    // one failure of that filter nobody would otherwise notice.
    db
      .select({ internalUsers: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(isInternalUser),
    // Real users with any sign of life in the window — the DAU / WAU pair.
    db
      .select({
        activeUsers24h: sql<number>`COUNT(*) FILTER (WHERE ${lastActiveAtSql} >= ${since24.toISOString()})::int`.mapWith(Number),
        activeUsers7d: sql<number>`COUNT(*) FILTER (WHERE ${lastActiveAtSql} >= ${since7d.toISOString()})::int`.mapWith(Number),
      })
      .from(users)
      .where(isRealUser),
  ]);

  return {
    totalUsers,
    internalUsers,
    totalTrips,
    totalTemplates,
    totalLegs,
    totalChat,
    totalReplans,
    totalVehicles,
    newUsers24h,
    newUsers7d,
    totalDeletedUsers,
    activeUsers24h,
    activeUsers7d,
  };
}

/**
 * The signups since `hours` ago, newest first: who joined, whether they came
 * back, and whether they made anything. Internal accounts are left out to
 * match the signup count on the dashboard tile, and counted so the page can
 * say how many were hidden.
 */
export async function listNewSignups(hours: number, limit = 100) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [rows, [{ hiddenInternal }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
        lastActiveAt,
        tripCount: tripCountSql,
      })
      .from(users)
      .where(and(isRealUser, gte(users.createdAt, since)))
      .orderBy(desc(users.createdAt))
      .limit(limit),
    db
      .select({ hiddenInternal: sql<number>`COUNT(*)::int` })
      .from(users)
      .where(and(isInternalUser, gte(users.createdAt, since))),
  ]);
  return { rows, hiddenInternal, since };
}

export type NewSignupRow = Awaited<ReturnType<typeof listNewSignups>>['rows'][number];

/**
 * Failed-call counts by status class over a window — the Health tile. Uses the
 * same predicates as the /admin/errors filter, so the tile's "N 5xx" is
 * exactly the number of rows that filter shows.
 */
export async function getErrorCounts(hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`.mapWith(Number),
      c4xx: sql<number>`COUNT(*) FILTER (WHERE ${statusClassWhere('4xx')})::int`.mapWith(Number),
      c5xx: sql<number>`COUNT(*) FILTER (WHERE ${statusClassWhere('5xx')})::int`.mapWith(Number),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.success, false), gte(usageEvents.createdAt, since)));
  return { total: row?.total ?? 0, c4xx: row?.c4xx ?? 0, c5xx: row?.c5xx ?? 0 };
}

/** How many trips had a chat message in the window, and when the last one was. */
export async function getChatPulse(hours: number) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [[window], [latest]] = await Promise.all([
    db
      .select({
        trips: sql<number>`COUNT(DISTINCT ${chatHistory.tripId})::int`.mapWith(Number),
        messages: sql<number>`COUNT(*)::int`.mapWith(Number),
      })
      .from(chatHistory)
      .where(gte(chatHistory.createdAt, since)),
    db
      .select({ at: sql<Date | null>`MAX(${chatHistory.createdAt})`.mapWith(toDateOrNull) })
      .from(chatHistory),
  ]);
  return { trips: window?.trips ?? 0, messages: window?.messages ?? 0, lastAt: latest?.at ?? null };
}

/** Non-template trips, most recently touched first, with owner and leg count. */
export async function listAdminTrips(limit = 100) {
  return db
    .select({
      id: trips.id,
      name: trips.name,
      userId: trips.userId,
      userEmail: users.email,
      userName: users.name,
      legCount: sql<number>`(SELECT COUNT(*)::int FROM legs l WHERE l.trip_id = "trips"."id")`.mapWith(Number),
      startDateParsed: trips.startDateParsed,
      createdAt: trips.createdAt,
      updatedAt: trips.updatedAt,
    })
    .from(trips)
    .leftJoin(users, eq(users.id, trips.userId))
    .where(eq(trips.isTemplate, false))
    .orderBy(desc(trips.updatedAt))
    .limit(limit);
}

export type AdminTripRow = Awaited<ReturnType<typeof listAdminTrips>>[number];

const ADMIN_VEHICLES_LIST_LIMIT = 500;

export async function getAdminVehiclesOverview(limit = ADMIN_VEHICLES_LIST_LIMIT) {
  return db
    .select({
      vehicleId: vehicles.id,
      userId: vehicles.userId,
      userEmail: users.email,
      userName: users.name,
      userUnitsPref: users.unitsPref,
      name: vehicles.name,
      isDefault: vehicles.isDefault,
      rangeKm: vehicles.rangeKm,
      createdAt: vehicles.createdAt,
      updatedAt: vehicles.updatedAt,
    })
    .from(vehicles)
    .innerJoin(users, eq(vehicles.userId, users.id))
    .orderBy(desc(vehicles.updatedAt))
    .limit(limit);
}

export type AdminVehicleListRow = Awaited<ReturnType<typeof getAdminVehiclesOverview>>[number];

export async function getAdminVehicleById(vehicleId: string) {
  const rows = await db
    .select({
      vehicleId: vehicles.id,
      userId: vehicles.userId,
      userEmail: users.email,
      userName: users.name,
      userUnitsPref: users.unitsPref,
      name: vehicles.name,
      isDefault: vehicles.isDefault,
      rangeKm: vehicles.rangeKm,
      createdAt: vehicles.createdAt,
      updatedAt: vehicles.updatedAt,
    })
    .from(vehicles)
    .innerJoin(users, eq(vehicles.userId, users.id))
    .where(eq(vehicles.id, vehicleId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getRecentChatActivity(limit = 30) {
  return db
    .select({
      id: chatHistory.id,
      tripId: chatHistory.tripId,
      tripName: trips.name,
      userId: trips.userId,
      userEmail: users.email,
      role: chatHistory.role,
      content: chatHistory.content,
      hasChanges: sql<boolean>`${chatHistory.changesMade} IS NOT NULL`,
      createdAt: chatHistory.createdAt,
    })
    .from(chatHistory)
    .leftJoin(trips, eq(trips.id, chatHistory.tripId))
    .leftJoin(users, eq(users.id, trips.userId))
    .orderBy(desc(chatHistory.createdAt))
    .limit(limit);
}

export type RecentChatRow = Awaited<ReturnType<typeof getRecentChatActivity>>[number];

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

// ============================================================================
// Drill-in helpers — used by /admin/users, /admin/users/[id], /admin/errors,
// /admin/chats/[tripId]. All return raw rows; Date conversion + serialization
// happens in the page component.
// ============================================================================

export type UserSort =
  | 'joined_desc'
  | 'joined_asc'
  | 'name_asc'
  | 'name_desc'
  /** The three filters: each narrows to users who have any, then ranks them. */
  | 'spend_desc'
  | 'active_desc'
  | 'errors_desc';

export const USER_SORTS: readonly UserSort[] = [
  'joined_desc',
  'joined_asc',
  'name_asc',
  'name_desc',
  'spend_desc',
  'active_desc',
  'errors_desc',
] as const;

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

  const searchWhere = search
    ? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`))
    : undefined;
  const filterWhere =
    sort === 'spend_desc'
      ? sql`${spendMicrocentsSql} > 0`
      : sort === 'active_desc'
        ? sql`${lastActiveAtSql} IS NOT NULL`
        : sort === 'errors_desc'
          ? sql`${errorCountSql} > 0`
          : undefined;
  const where = and(searchWhere, filterWhere);

  // Every ranking ends on created_at so ties page deterministically.
  const orderBy =
    sort === 'joined_asc'
      ? [asc(users.createdAt)]
      : sort === 'name_asc'
        ? [asc(users.name), desc(users.createdAt)]
        : sort === 'name_desc'
          ? [desc(users.name), desc(users.createdAt)]
          : sort === 'spend_desc'
            ? [desc(spendMicrocentsSql), desc(users.createdAt)]
            : sort === 'active_desc'
              ? [desc(lastActiveAtSql), desc(users.createdAt)]
              : sort === 'errors_desc'
                ? [desc(errorCountSql), desc(users.createdAt)]
                : [desc(users.createdAt)];

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        createdAt: users.createdAt,
        lastActiveAt,
        tripCount: tripCountSql,
        spendMicrocents: spendMicrocentsSql,
        errorCount: errorCountSql,
      })
      .from(users)
      .where(where)
      .orderBy(...orderBy)
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
    viewportRows,
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
        // Both entitlement overrides, so the detail page can show why a
        // verdict looks the way it does: `comped` exempts, `paywallEnforced`
        // walls this one account while the global switch is off.
        comped: users.comped,
        paywallEnforced: users.paywallEnforced,
        /*
         * The message gate's strike state. On the DETAIL page rather than only
         * the dashboard, because the dashboard answers "is anyone paused right
         * now" and this answers the question actually asked when somebody
         * writes in: "why is Penny ignoring ME". A count of 2 is invisible
         * everywhere else and is the whole explanation for what happens next.
         */
        pennyStrikes: users.pennyStrikes,
        pennyLockedUntil: users.pennyLockedUntil,
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
        // The machine columns, not the free-text start_date/end_date (which
        // hold whatever the driver typed) — formatted by the page.
        startDateParsed: trips.startDateParsed,
        endDateParsed: trips.endDateParsed,
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
    db
      .select({
        viewport: userViewportTime.viewport,
        totalSeconds: userViewportTime.totalSeconds,
      })
      .from(userViewportTime)
      .where(eq(userViewportTime.userId, userId)),
  ]);

  if (!user) return null;

  const viewportTime = { mobile: 0, tablet: 0, desktop: 0 };
  for (const r of viewportRows) {
    if (r.viewport === 'mobile' || r.viewport === 'tablet' || r.viewport === 'desktop') {
      viewportTime[r.viewport] = Number(r.totalSeconds);
    }
  }

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
    viewportTime,
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
  /** HTTP status class read from the message — see `lib/httpStatusClass.ts`. */
  statusClass?: HttpStatusClass | null;
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
  if (opts.statusClass) {
    conditions.push(statusClassWhere(opts.statusClass));
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
export async function getChatForTrip(tripId: string) {
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


/**
 * Every store event we have recorded for one user, newest first.
 *
 * This is an AUDIT LOG read, not an entitlement decision — `subscription_events`
 * is history, and the answer to "has this account paid?" still comes only from
 * `@/server/payments`. Nothing here is allowed to grow into a second opinion
 * about access, and nothing here touches the `subscriptions` table, which that
 * module owns outright.
 *
 * The admin panel needs it because a refund, a duplicate delivery or an event
 * that arrived out of order is invisible in the current row: the row shows the
 * outcome, and this shows how it got there. `outcome` is the interesting
 * column — `ignored_stale` next to a `DID_RENEW` is the whole explanation for
 * a subscription that "should" be active and is not.
 *
 * Capped: this page is read by one person doing forensics, not paginated.
 */
export async function getSubscriptionEventsForUser(userId: string, limit = 50) {
  return db
    .select({
      id: subscriptionEvents.id,
      type: subscriptionEvents.type,
      outcome: subscriptionEvents.outcome,
      receivedAt: subscriptionEvents.receivedAt,
      eventTimeMs: subscriptionEvents.eventTimeMs,
      /**
       * Selected for the ADMIN_REVOKE / ADMIN_REACTIVATE rows, which carry the
       * admin's address and their typed reason in here and nowhere else — the
       * `subscriptions` columns only ever describe the latest revoke, and an
       * undo clears them. A store payload is large and nothing renders it, but
       * splitting this into a second query for fifty rows the page already
       * fetches would be the wrong trade.
       */
      payload: subscriptionEvents.payload,
    })
    .from(subscriptionEvents)
    .where(eq(subscriptionEvents.userId, userId))
    .orderBy(desc(subscriptionEvents.receivedAt))
    .limit(limit);
}
