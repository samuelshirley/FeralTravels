ALTER TABLE "legs" ADD COLUMN "leg_type" text DEFAULT 'drive' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "rest_days_after_driving" integer;