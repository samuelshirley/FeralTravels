import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { asUnitsPref, type UnitsPref } from '@/lib/units';
import { sanitizeAvatarUrl } from '@/lib/avatarUrl';

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

/**
 * Read the user's stored IANA timezone, or null if never captured. Callers that
 * need a concrete "today" should pass this straight to {@link todayISOInZone},
 * which treats null as UTC-fallback — so no normalization is needed here.
 */
export async function getUserTimezone(userId: string): Promise<string | null> {
  const rows = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const tz = rows[0]?.timezone;
  return tz && tz.trim() !== '' ? tz : null;
}

/**
 * Persist the user's IANA timezone (captured from the browser on load). Validated
 * against the runtime's Intl zone database so a malformed string can't poison the
 * day-math; an unrecognized zone is rejected (returns null, nothing written).
 */
export async function setUserTimezone(
  userId: string,
  raw: unknown,
): Promise<string | null> {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const tz = raw.trim();
  try {
    // Throws RangeError on an unknown timezone — the cheapest valid-zone check.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    return null;
  }
  await db.update(users).set({ timezone: tz }).where(eq(users.id, userId));
  return tz;
}

/**
 * The signed-in user's own identity, for their own account UI.
 *
 * Deliberately separate from `GET /api/me`, which stays PII-free (units +
 * timezone) because `UnitsProvider` calls it on every page load and had no
 * business pulling an address down with it. This is the identity read, and
 * it is only ever the CALLER's own row — there is no id parameter on the
 * route, so it cannot be pointed at anybody else.
 */
export async function getUserIdentity(
  userId: string
): Promise<{ email: string | null; name: string | null; image: string | null }> {
  const [row] = await db
    .select({ email: users.email, name: users.name, image: users.image })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return { email: null, name: null, image: null };
  return {
    email: row.email ?? null,
    name: row.name ?? null,
    /**
     * Re-checked on the way OUT as well as in. The column predates the
     * allowlist (Auth.js's adapter wrote whatever Google sent at user
     * creation), so an old row can hold a URL that would not be accepted
     * today. Filtering here means the fix reaches existing users without a
     * backfill migration, and a value that fails just becomes the glyph.
     */
    image: sanitizeAvatarUrl(row.image),
  };
}
