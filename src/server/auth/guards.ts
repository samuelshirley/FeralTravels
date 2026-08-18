import 'server-only';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/server/db/client';
import { trips, legs, routes, stops, tasks, gpxTrails, sessions, users } from '@/server/db/schema';
import { auth } from './index';

// The error classes live in ./errors so modules that only throw them (e.g.
// oauthIdentity.ts) can skip this file's Auth.js + DB import chain. Re-exported
// here so every existing import site keeps working unchanged.
export {
  HttpError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from './errors';
import { HttpError, UnauthorizedError, ForbiddenError, NotFoundError } from './errors';

/**
 * Mobile auth: resolve a `Authorization: Bearer <token>` header against the
 * SAME `sessions` table the Auth.js cookie path uses. The token IS a session
 * token — minted only by signInWithOtpCore (the real OTP flow), same entropy,
 * same expiry, revoked by deleting the row. This is NOT a parallel auth
 * system and NOT a bypass: no token exists without a completed OTP sign-in.
 *
 * Deliberately narrow: admin guards do NOT accept bearer tokens (the mobile
 * app has no admin surface; keep the admin attack surface cookie-only).
 */
async function userFromBearerToken(): Promise<{ id: string; email: string | null } | null> {
  let authz: string | null = null;
  try {
    authz = (await headers()).get('authorization');
  } catch {
    // headers() unavailable (e.g. called outside a request scope) — no bearer.
    return null;
  }
  if (!authz?.startsWith('Bearer ')) return null;
  const token = authz.slice('Bearer '.length).trim();
  if (!token) return null;

  const rows = await db
    .select({ userId: sessions.userId, expires: sessions.expires, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.sessionToken, token))
    .limit(1);
  if (rows.length === 0) return null;
  if (rows[0].expires < new Date()) return null;
  return { id: rows[0].userId, email: rows[0].email ?? null };
}

export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;
  const bearer = await userFromBearerToken();
  if (bearer) return bearer.id;
  throw new UnauthorizedError();
}

/**
 * Resolve the signed-in principal in one call: id + email + admin flag.
 *
 * Use this from routes that need to branch on admin status (e.g. to
 * exempt admins from rate limits) — it avoids the otherwise-easy
 * footgun of calling `requireUserId()` and then forgetting to also
 * fetch the email/admin separately. The `isAdmin` boolean uses the
 * canonical check in src/server/auth/admin.ts (hardcoded allowlist +
 * env restriction + verified email + DB flag).
 *
 * Throws UnauthorizedError if there's no session, mirroring
 * requireUserId. Sessions without an email value (shouldn't happen
 * with the current Auth.js config but belt-and-suspenders) always come
 * back with isAdmin=false.
 */
export async function requireUser(): Promise<{
  id: string;
  email: string | null;
  isAdmin: boolean;
}> {
  const session = await auth();
  if (session?.user?.id) {
    const email = session.user.email ?? null;
    const admin = email ? await isAdminEmail(email) : false;
    return { id: session.user.id, email, isAdmin: admin };
  }
  const bearer = await userFromBearerToken();
  if (bearer) {
    const admin = bearer.email ? await isAdminEmail(bearer.email) : false;
    return { id: bearer.id, email: bearer.email, isAdmin: admin };
  }
  throw new UnauthorizedError();
}

// Admin authorization lives in src/server/auth/admin.ts — hardcoded allowlist
// + env restriction + DB flag + verified email. Re-exported here for callers
// that already import from guards.

import { isAdminEmail } from './admin';

export async function requireAdmin(): Promise<{ id: string; email: string }> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) throw new UnauthorizedError();
  const ok = await isAdminEmail(session.user.email);
  if (!ok) throw new ForbiddenError();
  return { id: session.user.id, email: session.user.email };
}

export async function isAdmin(email?: string | null): Promise<boolean> {
  return isAdminEmail(email);
}

export async function assertTripOwnedByUser(tripId: string, userId: string): Promise<void> {
  const row = await db
    .select({ userId: trips.userId })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Trip not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
}

/**
 * Allow read access if the user owns the trip OR the trip is a public template.
 * Templates are read-only for non-owners; mutations should still go through assertTripOwnedByUser.
 */
export async function assertTripReadableByUser(tripId: string, userId: string): Promise<void> {
  const row = await db
    .select({ userId: trips.userId, isTemplate: trips.isTemplate })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Trip not found');
  if (row[0].userId === userId) return;
  if (row[0].isTemplate) return;
  throw new ForbiddenError();
}

export async function assertLegOwnedByUser(legId: string, userId: string): Promise<string> {
  const row = await db
    .select({ tripId: legs.tripId, userId: trips.userId })
    .from(legs)
    .innerJoin(trips, eq(legs.tripId, trips.id))
    .where(eq(legs.id, legId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Leg not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
  return row[0].tripId;
}

export async function assertRouteOwnedByUser(routeId: string, userId: string): Promise<string> {
  const row = await db
    .select({ legId: routes.legId, userId: trips.userId })
    .from(routes)
    .innerJoin(legs, eq(routes.legId, legs.id))
    .innerJoin(trips, eq(legs.tripId, trips.id))
    .where(eq(routes.id, routeId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Route not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
  return row[0].legId;
}

export async function assertStopOwnedByUser(stopId: string, userId: string): Promise<string> {
  const row = await db
    .select({ legId: stops.legId, userId: trips.userId })
    .from(stops)
    .innerJoin(legs, eq(stops.legId, legs.id))
    .innerJoin(trips, eq(legs.tripId, trips.id))
    .where(eq(stops.id, stopId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Stop not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
  return row[0].legId;
}

export async function assertTaskOwnedByUser(taskId: string, userId: string): Promise<string> {
  const row = await db
    .select({ tripId: tasks.tripId, userId: trips.userId })
    .from(tasks)
    .innerJoin(trips, eq(tasks.tripId, trips.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('Task not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
  return row[0].tripId;
}

export async function assertGpxOwnedByUser(gpxId: string, userId: string): Promise<string> {
  const row = await db
    .select({ tripId: gpxTrails.tripId, userId: trips.userId })
    .from(gpxTrails)
    .innerJoin(trips, eq(gpxTrails.tripId, trips.id))
    .where(eq(gpxTrails.id, gpxId))
    .limit(1);
  if (row.length === 0) throw new NotFoundError('GPX trail not found');
  if (row[0].userId !== userId) throw new ForbiddenError();
  return row[0].tripId;
}

/**
 * Generate a short, unique error correlation ID.
 * Format: "ERR-<timestamp36>-<random>" e.g. "ERR-m3x7k9-a1b2"
 * Short enough for users to read out loud, unique enough to find in Vercel logs.
 */
function generateErrorId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `ERR-${ts}-${rand}`;
}

/**
 * Convert any thrown HttpError into a JSON Response. Use inside API route try/catch.
 *
 * Every error response includes an `errorId` field — a unique correlation ID
 * that is also logged server-side. Search Vercel logs for the errorId to find
 * the full stack trace and request context.
 */
export function errorResponse(err: unknown): Response {
  const errorId = generateErrorId();

  if (err instanceof HttpError) {
    // 4xx errors: log at warn level (expected client errors)
    console.warn(`[${errorId}] HTTP ${err.status}: ${err.message}`);
    return Response.json(
      { error: err.message, errorId },
      { status: err.status },
    );
  }

  // Connection-level noise: the client disconnected before the server finished.
  // Not actionable — downgrade to debug so it doesn't clutter logs/CI output.
  if (
    err instanceof Error &&
    ('code' in err && (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
      err.message === 'aborted')
  ) {
    console.debug(`[${errorId}] Client disconnected (${err.message})`);
    return Response.json(
      { error: 'Client disconnected', errorId },
      { status: 499 },
    );
  }

  // 5xx: log the full error at error level for debugging
  console.error(`[${errorId}] Unhandled API error:`, err);
  const message = err instanceof Error ? err.message : 'Internal error';
  return Response.json(
    { error: message, errorId },
    { status: 500 },
  );
}
