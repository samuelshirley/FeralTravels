import 'server-only';
import { sql, desc, gte, eq } from 'drizzle-orm';
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
