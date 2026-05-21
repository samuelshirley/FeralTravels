ALTER TABLE "legs" ADD COLUMN IF NOT EXISTS "leg_type" text DEFAULT 'drive' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "rest_days_after_driving" integer;