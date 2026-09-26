import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { createAdHocTrip, seedCanonicalTrip } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: create a throwaway `playwright-`-prefixed trip for a single spec.
 * `name` must already carry the run prefix so cleanup sweeps it. 404 unless the
 * test endpoints are enabled.
 *
 * `kind: 'canonical'` seeds the twelve-leg canonical trip ("August Portugal
 * Trip", real geometry and fuel stops, every sourced leg's fuel cache fresh)
 * and returns its legs as `{ id, sortOrder, title }` so a flow can open one.
 */
const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  kind: z.enum(['blank', 'onboarding', 'vehicle_new', 'canonical']),
  /**
   * A 'blank' trip's start date, when a spec needs chosen dates (the trips-list
   * date headers). ISO only; refused for the onboarding kinds, whose point is
   * that the date question has not been answered.
   */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((b) => b.startDate === undefined || b.kind === 'blank', {
  message: 'startDate is only for kind=blank',
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    if (body.kind === 'canonical') {
      const seeded = await seedCanonicalTrip({ email: body.email, name: body.name });
      return Response.json({ ok: true, ...seeded });
    }
    const result = await createAdHocTrip({ ...body, kind: body.kind });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
