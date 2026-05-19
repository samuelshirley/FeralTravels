ALTER TABLE "legs" ADD COLUMN "geometry" jsonb;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "place_id" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "google_maps_uri" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "photos" jsonb;