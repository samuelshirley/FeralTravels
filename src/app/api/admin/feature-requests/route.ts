import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { createFeatureRequest, listFeatureRequestsForAdmin } from '@/server/repos/featureRequests';
import { FEATURE_REQUEST_BODY_MAX, FEATURE_REQUEST_TITLE_MAX } from '@/lib/featureRequests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The list, for /admin/feature-requests to re-read after a change. */
export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ requests: await listFeatureRequestsForAdmin() });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Create a feature request (the "New request" form on /admin/feature-requests).
 * `requireAdmin()` is cookie-only, so the app can never reach this.
 */
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(FEATURE_REQUEST_TITLE_MAX),
    body: z
      .string()
      .trim()
      .max(FEATURE_REQUEST_BODY_MAX)
      .nullish()
      .transform((b) => (b ? b : null)),
  })
  .strict();

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const data = createSchema.parse(await request.json());
    return Response.json(await createFeatureRequest(data));
  } catch (err) {
    return errorResponse(err);
  }
}
