import 'server-only';
import { db } from '@/server/db/client';
import { announcements, announcementDismissals } from '@/server/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';

// ── User-facing ─────────────────────────────────────────────────────────────

/**
 * Return the newest active announcement that this user has NOT dismissed,
 * or null if there's nothing to show.
 */
export async function getActiveAnnouncementForUser(userId: string) {
  const rows = await db
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      buttonText: announcements.buttonText,
      createdAt: announcements.createdAt,
    })
    .from(announcements)
    .leftJoin(
      announcementDismissals,
      and(
        eq(announcementDismissals.announcementId, announcements.id),
        eq(announcementDismissals.userId, userId),
      ),
    )
    .where(
      and(
        eq(announcements.active, true),
        sql`${announcementDismissals.userId} IS NULL`,
      ),
    )
    .orderBy(desc(announcements.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Mark an announcement as dismissed for a user (idempotent). */
export async function dismissAnnouncement(userId: string, announcementId: string) {
  await db
    .insert(announcementDismissals)
    .values({ userId, announcementId })
    .onConflictDoNothing();
}

// ── Admin ───────────────────────────────────────────────────────────────────

/** List all announcements (newest first) for the admin panel. */
export async function listAnnouncements() {
  return db
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      buttonText: announcements.buttonText,
      active: announcements.active,
      createdAt: announcements.createdAt,
      dismissCount: sql<number>`(
        SELECT COUNT(*)::int FROM announcement_dismissals
        WHERE announcement_id = ${announcements.id}
      )`,
    })
    .from(announcements)
    .orderBy(desc(announcements.createdAt));
}

/** Create a new announcement (active by default). */
export async function createAnnouncement(data: {
  title: string;
  body: string;
  buttonText?: string;
}) {
  const [row] = await db
    .insert(announcements)
    .values({
      title: data.title,
      body: data.body,
      buttonText: data.buttonText ?? 'Got it',
    })
    .returning();
  return row;
}

/** Deactivate an announcement so it stops showing. */
export async function deactivateAnnouncement(id: string) {
  await db
    .update(announcements)
    .set({ active: false })
    .where(eq(announcements.id, id));
}

/** Reactivate an announcement. */
export async function activateAnnouncement(id: string) {
  await db
    .update(announcements)
    .set({ active: true })
    .where(eq(announcements.id, id));
}

/** Get count of active announcements (for admin dashboard stat card). */
export async function getAnnouncementStats() {
  const [{ activeCount }] = await db
    .select({ activeCount: sql<number>`COUNT(*)::int` })
    .from(announcements)
    .where(eq(announcements.active, true));

  const [{ totalCount }] = await db
    .select({ totalCount: sql<number>`COUNT(*)::int` })
    .from(announcements);

  return { activeCount, totalCount };
}
