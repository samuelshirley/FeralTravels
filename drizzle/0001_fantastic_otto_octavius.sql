ALTER TABLE "legs" ADD COLUMN IF NOT EXISTS "geometry" jsonb;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "place_id" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "google_maps_uri" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN IF NOT EXISTS "photos" jsonb;