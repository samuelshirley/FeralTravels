-- Persist up-to-2 alternate gas-station / rest-stop candidates per stop row
-- so the UI can offer a swap dropdown without re-querying Google Places.
-- Each entry is { name, lat, lng, place_id, distance_km }. Nullable: most
-- non-fuel/rest stops (water, food, overnight, user-authored) leave it null.
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "alternatives" jsonb;
