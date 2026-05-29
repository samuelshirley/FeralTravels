ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "current_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "current_lat" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "current_lng" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "progress_anchor_date" date;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "progress_updated_at" timestamp;