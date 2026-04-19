import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { trips, legs, routes, tasks, gpxTrails } from '@/server/db/schema';
import { auth } from './index';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthorizedError();
  return session.user.id;
}

export async function assertTripOwnedByUser(tripId: number, userId: string): Promise<void> {
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
export async function assertTripReadableByUser(tripId: number, userId: string): Promise<void> {
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

export async function assertLegOwnedByUser(legId: number, userId: string): Promise<number> {
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

export async function assertRouteOwnedByUser(routeId: number, userId: string): Promise<number> {
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

export async function assertTaskOwnedByUser(taskId: number, userId: string): Promise<number> {
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

export async function assertGpxOwnedByUser(gpxId: number, userId: string): Promise<number> {
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
 * Convert any thrown HttpError into a JSON Response. Use inside API route try/catch.
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error('Unhandled API error:', err);
  const message = err instanceof Error ? err.message : 'Internal error';
  return Response.json({ error: message }, { status: 500 });
}
