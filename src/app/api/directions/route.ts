import { requireUserId, errorResponse } from '@/server/auth/guards';
import { getDirections } from '@/lib/directions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireUserId();
    const { searchParams } = new URL(request.url);
    const startLat = parseFloat(searchParams.get('startLat') || '');
    const startLng = parseFloat(searchParams.get('startLng') || '');
    const endLat = parseFloat(searchParams.get('endLat') || '');
    const endLng = parseFloat(searchParams.get('endLng') || '');
    if (isNaN(startLat) || isNaN(startLng) || isNaN(endLat) || isNaN(endLng)) {
      return Response.json(
        { error: 'Provide startLat, startLng, endLat, endLng as query params' },
        { status: 400 }
      );
    }
    const result = await getDirections(startLat, startLng, endLat, endLng);
    if (!result) return Response.json({ error: 'Failed to get directions from OSRM' }, { status: 500 });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
