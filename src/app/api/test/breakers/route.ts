import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { seedGlobalSpend, clearGlobalSpend } from '@/server/repos/testSupport';
import { breakerSnapshot, setPennyLocked, invalidateBreakerFacts } from '@/server/payments';

/**
 * TEST-ONLY: put the app's global circuit breakers into a known state.
 *
 * `e2e/breakers.spec.ts` is the only caller. It exists because the breakers are
 * the one defence whose whole value is what happens at a threshold nobody wants
 * to reach for real — the unit tests prove the arithmetic, and this proves the
 * arithmetic is WIRED to the route that spends the money.
 *
 * Same three guards as the rest of `/api/test/*`: `E2E_TEST_ENDPOINTS=1` (never
 * true on Vercel production, no override), the per-run secret in
 * `x-e2e-test-secret`, and — for the seeding action — the fixture-address
 * pattern enforced in the repo layer.
 *
 * `state` reads the snapshot UNCACHED, so a spec can tell "the breaker has not
 * noticed yet" apart from "the breaker did not fire", which are the same
 * symptom and completely different bugs.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('seed-spend'),
    email: z.string().email(),
    /** Microcents to add to the global 24h total. $1 = 1e8. */
    microcents: z.number().int().positive(),
  }),
  /** Takes no marker — see `clearGlobalSpend` for why that is deliberate. */
  z.object({ action: z.literal('clear-spend') }),
  z.object({ action: z.literal('set-lock'), locked: z.boolean() }),
  z.object({ action: z.literal('state') }),
]);

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());

    if (body.action === 'seed-spend') {
      const seeded = await seedGlobalSpend({
        email: body.email,
        microcents: body.microcents,
      });
      // This instance's cached reading is now wrong. Other instances read fresh
      // anyway on a deployment with these endpoints on (see `cacheMs` in
      // breakerCheck.ts), which is what makes the spec deterministic.
      invalidateBreakerFacts();
      return Response.json({ ok: true, ...seeded });
    }

    if (body.action === 'clear-spend') {
      const cleared = await clearGlobalSpend();
      invalidateBreakerFacts();
      return Response.json({ ok: true, ...cleared });
    }

    if (body.action === 'set-lock') {
      await setPennyLocked(body.locked);
      invalidateBreakerFacts();
      return Response.json({ ok: true, locked: body.locked });
    }

    const snapshot = await breakerSnapshot();
    return Response.json({
      ok: true,
      worst: snapshot.worst,
      locked: snapshot.facts.manualLock,
      statuses: snapshot.statuses.map((s) => ({
        id: s.id,
        level: s.level,
        value: s.value,
        stopAt: s.stopAt,
      })),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
