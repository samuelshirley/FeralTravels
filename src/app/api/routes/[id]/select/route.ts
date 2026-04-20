import { and, eq, sql } from 'drizzle-orm';
import {
  requireUserId,
  assertRouteOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { selectRoute } from '@/server/repos/routes';
import { db } from '@/server/db/client';
import { tasks } from '@/server/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Marks a route as the leg's selected option (status='selected') and demotes
 * sibling routes back to status='option'. As a side effect, any open
 * Penny-created task on the same leg whose title looks like the
 * "Pick tonight's stop" prompt is auto-marked answered with the route label.
 *
 * This is a POST (no body) rather than PATCH because it operates on multiple
 * rows transactionally and isn't idempotent in the sibling-demotion sense.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireUserId();
    const id = parseInt(params.id, 10);
    if (Number.isNaN(id)) {
      return Response.json({ error: 'id must be a number' }, { status: 400 });
    }
    await assertRouteOwnedByUser(id, userId);

    const result = await selectRoute(id);
    if (!result) return Response.json({ error: 'Not found' }, { status: 404 });

    // B7: when the user picks tonight's stop, mark Penny's "Pick tonight's
    // stop" task on this leg as answered automatically.
    await db
      .update(tasks)
      .set({
        status: 'done',
        answer: result.route.end_name || result.route.label,
        answerSourceUrl: result.route.end_source_url,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.legId, result.legId),
          sql`LOWER(${tasks.title}) LIKE 'pick tonight%'`,
          sql`${tasks.status} = 'open'`
        )
      );

    return Response.json(result.route);
  } catch (err) {
    return errorResponse(err);
  }
}
