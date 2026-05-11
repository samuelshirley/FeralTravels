import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { db } from '@/server/db/client';
import { userViewportTime } from '@/server/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reject forged clients trying to spike aggregates in one request (~10 min wall clock per flush). */
const MAX_TOTAL_DELTA_SECONDS = 600;

const postSchema = z.object({
  deltas: z.object({
    mobile: z.number().finite().int().min(0),
    tablet: z.number().finite().int().min(0),
    desktop: z.number().finite().int().min(0),
  }),
});

const VIEWPORTS = ['mobile', 'tablet', 'desktop'] as const;

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = postSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: 'Invalid body' }, { status: 400 });
    }
    const { deltas } = parsed.data;
    const total = deltas.mobile + deltas.tablet + deltas.desktop;
    if (total === 0) {
      return Response.json({ ok: true });
    }
    if (total > MAX_TOTAL_DELTA_SECONDS) {
      return Response.json({ error: 'Delta cap exceeded' }, { status: 400 });
    }

    const now = new Date();
    for (const viewport of VIEWPORTS) {
      const delta = deltas[viewport];
      if (delta <= 0) continue;
      await db
        .insert(userViewportTime)
        .values({
          userId,
          viewport,
          totalSeconds: delta,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userViewportTime.userId, userViewportTime.viewport],
          set: {
            totalSeconds: sql`${userViewportTime.totalSeconds} + ${delta}`,
            updatedAt: now,
          },
        });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
