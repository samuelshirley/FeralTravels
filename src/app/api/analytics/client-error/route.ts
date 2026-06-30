import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Client-side error beacon.
 *
 * The Penny chat stream lives on a fetch the browser tears down whenever the
 * PWA is backgrounded/closed mid-turn (the dominant cause of the "Something
 * went wrong" bubble). When that throws, the failure was previously a pure
 * black hole: a generic string set in React state, `console.warn` only (invisible
 * on mobile), nothing persisted, nothing in /admin/errors. This endpoint gives
 * those client-only failures a server trail so we can confirm cause + frequency.
 *
 * It logs to usage_events (provider `penny:client-stream-error`) so the rows
 * surface in the admin Recent errors view alongside server failures. This is
 * diagnostics only — it never mutates trip state.
 */
const postSchema = z.object({
  tripId: z.string().uuid().nullable().optional(),
  /** Short user-facing code shown in the error bubble (e.g. "S-1a2b3c"). */
  code: z.string().min(1).max(40),
  /** Where in the stream lifecycle it failed. */
  phase: z.enum(['stream-threw', 'stream-incomplete']),
  /** Real error text (truncated client-side; we cap again here). */
  message: z.string().max(500).optional(),
  /** True if the page was hidden/backgrounded when the stream died. */
  hidden: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = postSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json({ error: 'Invalid body' }, { status: 400 });
    }
    const { tripId, code, phase, message, hidden } = parsed.data;

    const detail = [
      `[${code}]`,
      phase,
      hidden ? '(page hidden)' : '(page visible)',
      message ? `— ${message}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);

    await logUsageEvent({
      userId,
      tripId: tripId ?? null,
      provider: 'penny:client-stream-error',
      requests: 0,
      success: false,
      errorMessage: detail,
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
