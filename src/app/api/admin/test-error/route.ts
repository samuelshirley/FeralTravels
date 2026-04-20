import { NextRequest } from 'next/server';
import { auth } from '@/server/auth';
import { isAdmin, errorResponse, HttpError } from '@/server/auth/guards';

/**
 * Admin-only smoke test for the global ErrorNotifier.
 *
 *   GET /api/admin/test-error?kind=4xx   → 400 (toast)
 *   GET /api/admin/test-error?kind=5xx   → 500 (silly modal)
 *
 * Network-failure testing is done client-side by pointing fetch at an
 * invalid host — see AdminTestErrorButton.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user?.email || !(await isAdmin(session.user.email))) {
      throw new HttpError(404, 'Not found');
    }
    const kind = req.nextUrl.searchParams.get('kind');
    if (kind === '4xx') {
      throw new HttpError(400, 'Deliberate 400 — this is just a drill.');
    }
    if (kind === '5xx') {
      throw new Error('Deliberate 500 — the silly modal should now be open.');
    }
    return Response.json({ ok: true, message: 'Pass ?kind=4xx or ?kind=5xx' });
  } catch (err) {
    return errorResponse(err);
  }
}
