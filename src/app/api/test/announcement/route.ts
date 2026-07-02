import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { seedAnnouncement, cleanupAnnouncement } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: seed (POST) / clean up (DELETE) an announcement for the
 * announcement E2E. 404 unless test endpoints are enabled.
 */
const seedSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  buttonText: z.string().min(1),
});

const cleanupSchema = z.object({
  announcementId: z.string().min(1),
  parkedIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = seedSchema.parse(await req.json());
    const result = await seedAnnouncement(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = cleanupSchema.parse(await req.json());
    await cleanupAnnouncement(body);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
