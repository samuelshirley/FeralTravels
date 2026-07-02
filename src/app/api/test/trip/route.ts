import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { createAdHocTrip } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: create a throwaway `playwright-`-prefixed trip for a single spec.
 * `name` must already carry the run prefix so cleanup sweeps it. 404 unless the
 * test endpoints are enabled.
 */
const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  kind: z.enum(['blank', 'onboarding', 'vehicle_new']),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    const result = await createAdHocTrip(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
