import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import {
  applySubscriptionEvent,
  normalizeWebhookEvent,
  revenueCatWebhookSchema,
  type NormalizedSubscriptionEvent,
} from '@/server/payments';

// node:crypto and the payments module are both server-side. Never the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RevenueCat → us. The only inbound path that can grant paid access.
 *
 * Authentication is the shared secret configured in RevenueCat's dashboard,
 * which it sends verbatim as the `Authorization` header. That string must
 * match `REVENUECAT_WEBHOOK_SECRET` exactly — including any `Bearer ` prefix,
 * if you typed one into the dashboard.
 *
 * **Missing env refuses everything with a 503.** Not a 200, and above all not
 * an open door: an unset secret is a deploy that is not finished, and a
 * handler that default-opens on a missing variable is one `vercel env rm` away
 * from letting anybody on the internet mint subscriptions. 503 is also the
 * honest answer — RevenueCat retries it, so events queued during a misconfigured
 * window are delivered once the variable is set, instead of being lost.
 *
 * Status codes are chosen by what a RETRY would do, because RevenueCat retries
 * every non-2xx:
 *   - 200 — handled, including "ignored on purpose". A retry cannot improve it.
 *   - 401 / 400 — the caller is wrong (bad secret, unparseable body). Retrying
 *     will not fix it, but neither will pretending we accepted it.
 *   - 503 — we are not configured yet. Come back.
 *   - 500 — our database misbehaved. This is the one case where we WANT the
 *     retry, so the error is not swallowed into a 200.
 */
export async function POST(req: Request) {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[api/webhooks/revenuecat] REVENUECAT_WEBHOOK_SECRET is not set; refusing');
    return Response.json({ error: 'NotConfigured' }, { status: 503 });
  }

  const provided = req.headers.get('authorization');
  if (!provided || !secretMatches(provided, expected)) {
    console.warn('[api/webhooks/revenuecat] rejected: bad or missing Authorization header');
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Typed rather than left to evolve — the codebase does not allow `any`.
  let event: NormalizedSubscriptionEvent;
  try {
    event = normalizeWebhookEvent(revenueCatWebhookSchema.parse(await req.json()));
  } catch (err) {
    // An unknown notification TYPE is not this: the schema takes any string
    // there and the handler decides. Landing here means the body was not a
    // RevenueCat webhook at all, or was missing the id / type / app_user_id
    // that make it actionable.
    const detail = err instanceof ZodError ? err.issues[0]?.path.join('.') : 'unparseable body';
    console.warn('[api/webhooks/revenuecat] rejected: invalid payload', detail);
    return Response.json({ error: 'InvalidPayload' }, { status: 400 });
  }

  try {
    const result = await applySubscriptionEvent(event);
    return Response.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    console.error('[api/webhooks/revenuecat] failed to apply event', event.eventId, err);
    return Response.json({ error: 'ApplyFailed' }, { status: 500 });
  }
}

/**
 * Constant-time comparison of two secrets.
 *
 * `timingSafeEqual` throws unless both buffers are the same length, and
 * returning early on a length mismatch would leak the secret's length one
 * request at a time. Hashing both sides to a fixed 32 bytes removes the
 * length signal and the throw together.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
