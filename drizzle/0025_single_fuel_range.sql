ALTER TABLE "vehicles" RENAME COLUMN "comfortable_range_km" TO "range_km";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "hard_max_range_km";