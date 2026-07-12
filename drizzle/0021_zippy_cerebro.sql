ALTER TABLE "trips" ADD COLUMN "declared_range_km" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "declared_range_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "declared_range_at" timestamp;