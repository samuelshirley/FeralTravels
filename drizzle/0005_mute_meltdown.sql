DO $$ BEGIN CREATE TYPE "public"."constraint_type" AS ENUM('arrive_by', 'depart_after', 'flexible'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."travel_style" AS ENUM('scenic_cruiser', 'road_tripper', 'get_me_there'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."trip_status" AS ENUM('draft', 'active', 'paused', 'completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_dismissals" (
	"user_id" text NOT NULL,
	"announcement_id" uuid NOT NULL,
	"dismissed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_user_id_announcement_id_pk" PRIMARY KEY("user_id","announcement_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"button_text" text DEFAULT 'Got it' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leg_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leg_id" uuid NOT NULL,
	"constraint_type" "constraint_type" NOT NULL,
	"constraint_datetime" timestamp with time zone,
	"buffer_minutes" integer DEFAULT 60 NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "start_date_parsed" date;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "end_date_parsed" date;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "trip_status" "trip_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "pending_intent" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "last_known_lat" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "last_known_lng" double precision;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "position_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "travel_style" "travel_style";--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "cruise_max_drive_hours" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "transit_max_drive_hours" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "dump_station_interval_days" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "dump_station_tracking_enabled" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_dismissals" ADD CONSTRAINT "announcement_dismissals_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leg_constraints" ADD CONSTRAINT "leg_constraints_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_dismissals_user_idx" ON "announcement_dismissals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leg_constraints_leg_idx" ON "leg_constraints" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trips_trip_status_idx" ON "trips" USING btree ("trip_status");--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "water_refill_days";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "blackwater_refill_days";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "water_tracking_enabled";