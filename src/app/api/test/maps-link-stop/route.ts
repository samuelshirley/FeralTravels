import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { fixtureUserOwningTrip } from '@/server/repos/testSupport';
import { resolveMapsLinksInMessage } from '@/lib/coordsResolve';
import { buildPennyContext } from '@/lib/penny/context';
import { VALIDATORS } from '@/lib/penny/tools';
import { ADD_STOP, type AddStopInput } from '@/lib/penny/tools/addStop';
import { applyAddStop } from '@/server/pennyAddStop';

/**
 * TEST-ONLY: turn a chat message carrying a Maps link into a stop, through
 * Penny's own code and without Penny.
 *
 * The path a pasted link takes in a real turn is: `resolveMapsLinksInMessage`
 * (the server resolves the link before the model sees it) → Penny calls
 * `add_stop` with the resolved lat/lng and name → the server validates it with
 * `VALIDATORS.add_stop` → `applyAddStop` writes it. This runs every one of
 * those steps except the model, whose only job there is to copy fields across —
 * so a flow can prove a real share link lands as a stop on the real day card
 * without an Anthropic call on every CI run.
 *
 * The link IS fetched live (a free short-link expansion; zero Places calls on
 * Google's current page). That is the point: it is Google's live behaviour the
 * resolver keeps having to track.
 *
 * Fixture DATA like the rest of /api/test/* — 404 unless test endpoints are
 * enabled (always false on production, no override), the per-run HMAC in
 * x-e2e-test-secret, and `fixtureUserOwningTrip` refuses any address outside
 * FIXTURE_EMAIL_PATTERN or a trip that address does not own.
 *
 * POST and force-dynamic for the reason spelled out in ../otp/route.ts.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  tripId: z.string().uuid(),
  legId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  status: z.enum(['option', 'selected']).default('selected'),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    const userId = await fixtureUserOwningTrip(body.email, body.tripId);
    const who = { userId, tripId: body.tripId };

    const [link] = await resolveMapsLinksInMessage(body.message, who);
    if (!link) {
      return Response.json({ ok: false, error: 'no Maps link in message' }, { status: 422 });
    }
    if (!link.resolved || link.lat == null || link.lng == null) {
      return Response.json({ ok: false, error: `link did not resolve (stage=${link.stage})`, link }, { status: 422 });
    }
    if (!link.name) {
      return Response.json({ ok: false, error: 'link resolved without a place name', link }, { status: 422 });
    }

    const context = await buildPennyContext(body.tripId, userId);
    if (!context) return Response.json({ ok: false, error: 'trip not found' }, { status: 404 });

    // Exactly the add_stop Penny is told to write for a resolved link.
    const proposed: AddStopInput = {
      leg_id: body.legId,
      data: {
        stop_type: 'other',
        name: link.name,
        lat: link.lat,
        lng: link.lng,
        status: body.status,
        source: 'user',
        source_url: link.url,
      },
    };
    const validated = VALIDATORS[ADD_STOP](context).safeParse(proposed);
    if (!validated.success) {
      return Response.json(
        { ok: false, error: 'add_stop validation failed', issues: validated.error.issues, link },
        { status: 422 },
      );
    }

    const stopId = await applyAddStop(validated.data as AddStopInput, body.tripId, userId, {
      newLegIdsQueue: [],
      newLegs: [],
    });
    return Response.json({ ok: true, link, stopId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
