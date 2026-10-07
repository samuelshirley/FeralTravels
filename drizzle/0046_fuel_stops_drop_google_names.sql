-- Fuel stops stop carrying Google's station name and Google's own link.
--
-- Google Maps Platform ToS §3.2.3 forbids caching a business name, and a
-- Place's `googleMapsUri` has no caching allowance; the `place_id` may be kept
-- forever. From this release Finn (src/server/fuel.ts) stores the name
-- 'Fuel stop' (FUEL_STOP_NAME) and, as both `google_maps_uri` and `source_url`,
-- our own drive link built from the coordinates and the place_id. Clients label
-- the row "Fuel stop · 212 km" from `stop_type`, not from the name.
--
-- This rewrites the rows Finn saved before that. The link is byte-for-byte the
-- URL `buildGoHereUrl(lat, lng, { placeId })` in src/lib/maps.ts produces
-- (URLSearchParams encodes the comma as %2C); maps.test.ts reads this file and
-- holds the two in step. A row with no coordinates gets no link, as in TS.
-- `alternatives` held other stations' names, so it is cleared too.
--
-- Data only, no DDL: a running old build reads the rewritten rows fine, and a
-- re-run is a no-op.
UPDATE "stops" SET
  "name" = 'Fuel stop',
  "google_maps_uri" = CASE
    WHEN "lat" IS NOT NULL AND "lng" IS NOT NULL THEN
      'https://www.google.com/maps/dir/?api=1&destination=' || "lat"::text || '%2C' || "lng"::text
        || '&travelmode=driving&dir_action=navigate'
        || CASE WHEN "place_id" IS NOT NULL AND "place_id" <> ''
             THEN '&destination_place_id=' || "place_id" ELSE '' END
    ELSE NULL
  END,
  "source_url" = CASE
    WHEN "lat" IS NOT NULL AND "lng" IS NOT NULL THEN
      'https://www.google.com/maps/dir/?api=1&destination=' || "lat"::text || '%2C' || "lng"::text
        || '&travelmode=driving&dir_action=navigate'
        || CASE WHEN "place_id" IS NOT NULL AND "place_id" <> ''
             THEN '&destination_place_id=' || "place_id" ELSE '' END
    ELSE NULL
  END,
  "alternatives" = NULL
WHERE "stop_type" = 'fuel' AND "source" IN ('google', 'google_places');
