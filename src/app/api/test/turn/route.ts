import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { finishPennyTurn, seedPennyTurn } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: plant a `penny_turns` row for a fixture user's trip, so a spec can
 * open the chat screen while the server is "mid-answer" without asking Penny to
 * plan anything.
 *
 * Fixture DATA, like every other route under /api/test — it grants nothing and
 * bypasses no authentication. 404 unless test endpoints are enabled, which is
 * ALWAYS false on Vercel production with no override; plus the per-run HMAC in
 * x-e2e-test-secret, and a fixture-address check inside the repo because this
 * one WRITES rows.
 *
 * POST and force-dynamic for the reason spelled out in ../otp/route.ts: a GET
 * route handler is prerendered at build time, before the flag that gates it is
 * set, and would serve a cached "Not found" to everyone.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({
    action: z.literal('seed'),
    email: z.string().email(),
    tripId: z.string().uuid(),
    status: z.enum(['queued', 'running', 'done', 'error']).default('running'),
    message: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal('finish'),
    email: z.string().email(),
    idempotencyKey: z.string().min(8).max(100),
    status: z.enum(['done', 'error']).optional(),
  }),
]);

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    if (body.action === 'finish') {
      await finishPennyTurn(body);
      return Response.json({ ok: true });
    }
    const { idempotencyKey } = await seedPennyTurn(body);
    return Response.json({ ok: true, idempotencyKey });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
