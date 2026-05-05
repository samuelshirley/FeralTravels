import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { asUnitsPref, type UnitsPref } from '@/lib/units';

/**
 * Read the user's units display preference. Returns 'metric' if the user
 * row is missing for any reason — onboarding-time race conditions, etc.
 *
 * This is hot-path for any page that renders a distance, so we keep the
 * select narrow. If the column ever grows, prefer adding a getUserPrefs()
 * that returns the whole row over fetching everything at every call site.
 */
export async function getUnitsPref(userId: string): Promise<UnitsPref> {
  const rows = await db
    .select({ unitsPref: users.unitsPref })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return asUnitsPref(rows[0]?.unitsPref);
}

/**
 * Persist the user's units display preference. Caller is responsible for
 * having authorized `userId`. Always normalizes through asUnitsPref so a
 * malformed value can't slip into the DB.
 */
export async function setUnitsPref(userId: string, raw: unknown): Promise<UnitsPref> {
  const pref = asUnitsPref(raw);
  await db.update(users).set({ unitsPref: pref }).where(eq(users.id, userId));
  return pref;
}
