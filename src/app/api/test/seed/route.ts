import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { seedFixture } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: reset a persona's graph and recreate the canonical fixture
 * (default vehicle + trip + two legs). 404 unless test endpoints are enabled.
 */
const bodySchema = z.object({
  email: z.string().email(),
  userName: z.string().optional(),
  vehicleName: z.string().min(1),
  tripName: z.string().min(1),
  /** Optional fixture vehicle range. Defaults to the Hilux's real 500 km. */
  rangeKm: z.number().int().min(50).max(2000).optional(),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    const result = await seedFixture(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
