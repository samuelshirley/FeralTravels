import 'server-only';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { db } from '@/server/db/client';
import { sessions } from '@/server/db/schema';
import { SESSION_COOKIE_NAMES } from '@/lib/sessionCookie';
import { SessionStoreUnavailableError } from './errors';

/**
 * Telling "signed out" apart from "the session store is down".
 *
 * `auth()` returns `null` for both, because Auth.js catches an adapter throw
 * and reports it as no session (see `SessionStoreUnavailableError` for the
 * incident). The evidence that separates them is already on the request: a
 * visitor who is genuinely signed out has NO session cookie. Somebody holding
 * one either has a row that has since gone, or is looking at an outage.
 */

/**
 * The session token from whichever cookie name this deployment writes, or null.
 *
 * `cookies()` throws when called outside a request scope, and `auth()` is
 * reachable from places that are not one — the same reason
 * `userFromBearerToken` wraps `headers()` in guards.ts. Treat that as "no
 * cookie": it is the answer that costs nothing, since a caller with no request
 * has no session to lose.
 */
export async function readSessionCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    for (const name of SESSION_COOKIE_NAMES) {
      const value = jar.get(name)?.value;
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Throw `SessionStoreUnavailableError` if the session store cannot be read.
 *
 * Deliberately re-runs the EXACT query Auth.js just failed at rather than a
 * `SELECT 1` liveness probe. Two reasons, and neither is style:
 *
 *   1. It asks the real question. A probe on a different table, or through a
 *      different pool, can succeed while the query that matters fails.
 *   2. It needs no raw SQL. There is no `db.execute` anywhere in `src/server`
 *      and this is not the place to introduce the first one — the repo rule is
 *      that SQL lives in `repos/`, and this is auth's own table, queried the
 *      same way `userFromBearerToken` already queries it.
 *
 * Returning normally means the store answered, so `auth()`'s `null` was the
 * truth: the row is gone or expired and the visitor really is signed out.
 */
export async function assertSessionStoreReachable(token: string): Promise<void> {
  try {
    await db
      .select({ sessionToken: sessions.sessionToken })
      .from(sessions)
      .where(eq(sessions.sessionToken, token))
      .limit(1);
  } catch (err) {
    /*
     * Logged here rather than left to the caller: by the time this reaches a
     * page it is a rendered error screen, and the cause — which Postgres said
     * what — is the only part worth having in the log.
     */
    console.error('[auth] session store unreachable:', err);
    throw new SessionStoreUnavailableError();
  }
}
