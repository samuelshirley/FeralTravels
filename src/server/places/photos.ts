import 'server-only';

export interface PlacePhoto {
  url: string;
  attribution: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Fetch photos for a Google place_id using the Places API (New).
 *
 * Strategy: request the Place Details for the place_id with the `photos`
 * field mask. Each photo resource has a name like
 * `places/{id}/photos/{photoRef}` — we construct the media URL from that.
 *
 * Falls back to Street View Static API if no Place Photos are available.
 */
export async function placePhotos(
  placeId: string,
  apiKey: string,
  opts?: { maxPhotos?: number; maxWidthPx?: number }
): Promise<PlacePhoto[]> {
  const maxPhotos = opts?.maxPhotos ?? 3;
  const maxWidthPx = opts?.maxWidthPx ?? 400;

  // Step 1: Get photo references from Place Details
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'photos',
        },
      }
    );

    if (!res.ok) {
      // Fall back to Street View
      return streetViewFallback(placeId, apiKey, maxWidthPx);
    }

    const data = (await res.json()) as {
      photos?: Array<{
        name: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: Array<{ displayName?: string }>;
      }>;
    };

    const photoRefs = data.photos ?? [];
    if (photoRefs.length === 0) {
      return streetViewFallback(placeId, apiKey, maxWidthPx);
    }

    // Step 2: Build photo URLs (up to maxPhotos)
    const photos: PlacePhoto[] = photoRefs.slice(0, maxPhotos).map((p) => {
      const attribution =
        p.authorAttributions?.[0]?.displayName ?? 'Google';
      return {
        url: `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=${maxWidthPx}&key=${apiKey}`,
        attribution,
        widthPx: p.widthPx ?? maxWidthPx,
        heightPx: p.heightPx ?? Math.round(maxWidthPx * 0.75),
      };
    });

    return photos;
  } catch {
    return streetViewFallback(placeId, apiKey, maxWidthPx);
  }
}

/**
 * Street View Static API fallback when no Place Photos exist.
 * Returns a single Street View image for the location.
 */
async function streetViewFallback(
  placeId: string,
  apiKey: string,
  widthPx: number
): Promise<PlacePhoto[]> {
  // Street View metadata check — avoid returning a "no image available" grey box
  try {
    const metaRes = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?pano=&location=&place_id=${placeId}&key=${apiKey}`
    );
    const meta = (await metaRes.json()) as { status?: string };
    if (meta.status !== 'OK') return [];
  } catch {
    return [];
  }

  const heightPx = Math.round(widthPx * 0.75);
  return [
    {
      url: `https://maps.googleapis.com/maps/api/streetview?size=${widthPx}x${heightPx}&place_id=${placeId}&key=${apiKey}`,
      attribution: 'Google Street View',
      widthPx,
      heightPx,
    },
  ];
}

/**
 * Fetch photos by coordinates (when no place_id is available).
 * Uses Street View only.
 */
export async function coordPhotos(
  lat: number,
  lng: number,
  apiKey: string,
  opts?: { maxWidthPx?: number }
): Promise<PlacePhoto[]> {
  const widthPx = opts?.maxWidthPx ?? 400;
  const heightPx = Math.round(widthPx * 0.75);

  try {
    const metaRes = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${apiKey}`
    );
    const meta = (await metaRes.json()) as { status?: string };
    if (meta.status !== 'OK') return [];
  } catch {
    return [];
  }

  return [
    {
      url: `https://maps.googleapis.com/maps/api/streetview?size=${widthPx}x${heightPx}&location=${lat},${lng}&key=${apiKey}`,
      attribution: 'Google Street View',
      widthPx,
      heightPx,
    },
  ];
}
