import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { asUnitsPref, type UnitsPref } from '@/lib/units';

/**
 * Read stored units preference, or null if the user has not chosen yet
 * (onboarding units_pick not completed).
 */
export async function getRawUnitsPref(userId: string): Promise<UnitsPref | null> {
  const rows = await db
    .select({ unitsPref: users.unitsPref })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const raw = rows[0]?.unitsPref;
  if (raw == null || raw === '') return null;
  return raw === 'imperial' ? 'imperial' : 'metric';
}

/**
 * Read the user's units display preference. Null / missing in DB is treated
 * as metric for UI so distances always render sensibly before onboarding.
 */
export async function getUnitsPref(userId: string): Promise<UnitsPref> {
  const pref = await getRawUnitsPref(userId);
  return pref ?? 'metric';
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
