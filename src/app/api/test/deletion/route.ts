import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import {
  deleteUsageByMarker,
  readDeletionState,
  seedUsageEvent,
} from '@/server/repos/testSupport';

/**
 * TEST-ONLY: the vantage point the account-deletion spec did not have.
 *
 * Deletion signs you out, so from inside a browser there is nothing left to
 * ask. Every assertion the spec could make afterwards was really an assertion
 * about the SESSION — `GET /api/trips` → 401 passes just as happily for an
 * implementation that deleted `sessions` and left every trip, usage row and
 * tombstone exactly where it was. This route answers "what does the database
 * still hold about that address" in counts and booleans.
 *
 * Three actions rather than three routes on purpose: they exist for one spec
 * and one property, and each new `/api/test/*` path is another door to reason
 * about. Both share the same three guards as the rest of the family —
 * E2E_TEST_ENDPOINTS=1 (never true on Vercel production, no override), the
 * per-run secret in `x-e2e-test-secret`, and the fixture-address pattern
 * enforced in the repo layer.
 *
 * It reads only. `seed-usage` writes one `usage_events` row so the spec has
 * something anonymisable to watch, and nothing here mints, grants or deletes.
 * The decrypted address is compared inside `readDeletionState` and never
 * crosses the wire, so this cannot be turned into a way to read addresses out
 * of `deleted_users`.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('seed-usage'),
    email: z.string().email(),
    /** Marker written to the NOT NULL `provider` column; deletion never touches it. */
    marker: z.string().min(1).max(64),
    /** Free text for `error_message`, which deletion must scrub. */
    text: z.string().min(1).max(200),
  }),
  z.object({
    action: z.literal('cleanup-usage'),
    /** Must start with `e2e-`; enforced again in the repo layer. */
    marker: z.string().min(1).max(64),
  }),
  z.object({
    action: z.literal('state'),
    email: z.string().email(),
    userId: z.string().nullish(),
    marker: z.string().nullish(),
  }),
]);

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());

    if (body.action === 'seed-usage') {
      const seeded = await seedUsageEvent({
        email: body.email,
        provider: body.marker,
        errorMessage: body.text,
      });
      return Response.json({ ok: true, ...seeded });
    }

    if (body.action === 'cleanup-usage') {
      return Response.json({ ok: true, ...(await deleteUsageByMarker(body.marker)) });
    }

    const state = await readDeletionState({
      email: body.email,
      userId: body.userId,
      marker: body.marker,
    });
    return Response.json({ ok: true, ...state });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
