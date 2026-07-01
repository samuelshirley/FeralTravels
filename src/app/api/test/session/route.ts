import { z } from 'zod';
import { isAuthTestBackdoorConfigured } from '@/server/auth/test-backdoor';
import { createTestSession } from '@/server/auth/test-session';

/**
 * TEST-ONLY: sign in as `email` (creating the user if needed) by minting a real
 * database session + cookie. Returns 404 unless the test backdoor is configured,
 * so it does not exist on real production. See src/server/auth/test-session.ts.
 */
const bodySchema = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  if (!isAuthTestBackdoorConfigured()) return new Response('Not found', { status: 404 });
  try {
    const { email } = bodySchema.parse(await req.json());
    const { userId } = await createTestSession(email);
    return Response.json({ ok: true, userId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
