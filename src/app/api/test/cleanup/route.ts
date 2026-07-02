import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { cleanupPlaywright } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: delete every `playwright-`-prefixed trip/vehicle for the persona.
 * 404 unless test endpoints are enabled.
 */
const bodySchema = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const { email } = bodySchema.parse(await req.json());
    const result = await cleanupPlaywright(email);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
