ALTER TABLE "trips" ADD COLUMN "current_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "current_lat" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "current_lng" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "progress_anchor_date" date;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "progress_updated_at" timestamp;