import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { seedFeatureRequest } from '@/server/repos/testSupport';
import { FEATURE_REQUEST_STATUSES } from '@/lib/featureRequests';

/**
 * TEST-ONLY: seed a feature request in a given state, for
 * e2e/feature-requests.spec.ts and mobile/maestro/feature-requests.yaml.
 * 404 unless test endpoints are enabled. No cleanup route, deliberately —
 * see `seedFeatureRequest`.
 */
const seedSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().max(1000).nullish(),
    status: z.enum(FEATURE_REQUEST_STATUSES).optional(),
    reply: z.string().max(1000).nullish(),
  })
  .strict();

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = seedSchema.parse(await req.json());
    return Response.json({ ok: true, ...(await seedFeatureRequest(body)) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
