import {
  requireUserId,
  assertTripReadableByUser,
  assertTripOwnedByUser,
  assertLegOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { getGpxTrailsForLeg, addGpxTrail } from '@/server/repos/gpx';
import { getLegTripId } from '@/server/repos/tasks';
import { approxDistanceKm, readGpxAsGeoJson, writeGpxFile, sanitizeFilename } from '@/lib/gpx';
import { parseUUID } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const userId = await requireUserId();
    const url = new URL(request.url);
    const tripIdRaw = url.searchParams.get('tripId');
    const legIdRaw = url.searchParams.get('legId');
    if (!legIdRaw) return Response.json({ error: 'legId is required' }, { status: 400 });
    const legId = parseUUID(legIdRaw);
    if (!legId) return Response.json({ error: 'legId must be a valid UUID' }, { status: 400 });
    const inferredTripId = tripIdRaw ? parseUUID(tripIdRaw) : await getLegTripId(legId);
    if (!inferredTripId) return Response.json({ error: 'Trip not found for leg' }, { status: 404 });
    await assertTripReadableByUser(inferredTripId, userId);

    const trails = await getGpxTrailsForLeg(legId);
    const out = await Promise.all(
      trails.map(async (t) => {
        try {
          const geojson = await readGpxAsGeoJson(t.filename);
          return {
            id: t.id,
            name: t.name,
            filename: t.filename,
            source: t.source,
            source_url: t.source_url,
            surface: t.surface,
            distance_km: t.distance_km,
            notes: t.notes,
            geojson,
          };
        } catch (err) {
          console.warn(`Failed to read GPX ${t.filename}:`, err);
          return null;
        }
      })
    );

    return Response.json(out.filter(Boolean));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return Response.json(
        {
          error:
            'Use multipart/form-data with fields: file (gpx), tripId, legId, name (optional), source (optional), sourceUrl (optional), surface (optional)',
        },
        { status: 400 }
      );
    }

    const form = await request.formData();
    const file = form.get('file');
    const tripIdRaw = form.get('tripId');
    const legIdRaw = form.get('legId');
    const name = (form.get('name') as string | null) || null;
    const source = (form.get('source') as string | null) || null;
    const sourceUrl = (form.get('sourceUrl') as string | null) || null;
    const surface = (form.get('surface') as string | null) || null;

    if (!(file instanceof File)) return Response.json({ error: 'file field is required' }, { status: 400 });
    if (!legIdRaw) return Response.json({ error: 'legId is required' }, { status: 400 });
    const legId = parseUUID(String(legIdRaw));
    if (!legId) return Response.json({ error: 'legId must be a valid UUID' }, { status: 400 });
    if (!file.name.toLowerCase().endsWith('.gpx'))
      return Response.json({ error: 'File must be .gpx' }, { status: 400 });

    const tripId = tripIdRaw ? parseUUID(String(tripIdRaw)) : await getLegTripId(legId);
    if (!tripId) return Response.json({ error: 'Trip not found for leg' }, { status: 404 });
    await assertTripOwnedByUser(tripId, userId);
    await assertLegOwnedByUser(legId, userId);

    const buffer = Buffer.from(await file.arrayBuffer());
    const finalName = `trip${tripId}-leg${legId}-${Date.now()}-${sanitizeFilename(file.name)}`;
    const savedFilename = await writeGpxFile(finalName, buffer);

    let distanceKm: number | null = null;
    try {
      const geojson = await readGpxAsGeoJson(savedFilename);
      distanceKm = approxDistanceKm(geojson);
    } catch (err) {
      console.warn('Could not pre-compute GPX distance:', err);
    }

    const trail = await addGpxTrail({
      trip_id: tripId,
      leg_id: legId,
      name: name || file.name.replace(/\.gpx$/i, ''),
      filename: savedFilename,
      source,
      source_url: sourceUrl,
      distance_km: distanceKm,
      surface,
    });

    return Response.json(trail, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
