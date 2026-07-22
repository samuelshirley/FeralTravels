-- Data migration: the auto fuel-stop planner's source marker was renamed
-- 'osm' -> 'google' at the Google-only cutover (Overpass/OSRM removed).
UPDATE "stops" SET "source" = 'google' WHERE "source" = 'osm';--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_state";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_per_litre";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_currency";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_fuel_type";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_country";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_source";--> statement-breakpoint
ALTER TABLE "stops" DROP COLUMN IF EXISTS "price_as_of";