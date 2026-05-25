import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { parseCoords, needsServerResolution } from '@/lib/coords';
import { resolveCoordsFromInput } from '@/lib/coordsResolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ input: z.string().min(1).max(2000) });

/**
 * Client-first coordinate parser with a server-side fallback for the only
 * URL shape that still needs redirect resolution: Google's Maps share
 * short links (maps.app.goo.gl / goo.gl / g.co). We follow redirects
 * manually so we can read the Location header of the canonical
 * google.com/maps/... URL and re-parse it with the pure client parser.
 *
 * iOverlander and Park4Night HTML scraping was intentionally removed: the
 * UX of pasting one of those URLs was brittle (pages redirect through
 * login walls on mobile, the HTML shape changes) and scraping their site
 * is uncomfortably close to their terms of service. Users paste raw
 * lat/lng from those apps now.
 *
 * Auth is required so anonymous scrapers can't turn this into a URL-expansion
 * proxy. Keeping the timeout short (5s) and the response small (just a lat/lng
 * pair + optional name) bounds the blast radius.
 */
export async function POST(request: Request) {
  try {
    await requireUserId();
    const { input } = schema.parse(await request.json());

    const direct = parseCoords(input);
    if (direct) return Response.json(direct);

    if (!needsServerResolution(input)) {
      return Response.json({ error: 'Could not parse coordinates from input.' }, { status: 400 });
    }

    const resolved = await resolveCoordsFromInput(input);
    if (!resolved) {
      return Response.json(
        { error: 'Could not resolve coordinates from that URL.' },
        { status: 422 }
      );
    }
    return Response.json(resolved);
  } catch (err) {
    return errorResponse(err);
  }
}
