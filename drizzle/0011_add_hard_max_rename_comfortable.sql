ALTER TABLE "vehicles" RENAME COLUMN "refill_distance_km" TO "comfortable_range_km";--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "hard_max_range_km" integer;--> statement-breakpoint
-- Backfill: existing vehicles inherit a hard ceiling equal to their comfortable
-- range (the conservative default — Finn never stretches past comfortable until
-- the driver sets a separate max). Leaves not-yet-onboarded rows (comfortable
-- NULL) untouched.
UPDATE "vehicles" SET "hard_max_range_km" = "comfortable_range_km" WHERE "hard_max_range_km" IS NULL AND "comfortable_range_km" IS NOT NULL;