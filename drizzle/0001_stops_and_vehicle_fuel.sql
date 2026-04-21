CREATE TABLE IF NOT EXISTS "stops" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"stop_type" text NOT NULL,
	"status" text DEFAULT 'option' NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"distance_from_start_km" double precision,
	"notes" text,
	"fuel_type" text,
	"fuel_amount_l" double precision,
	"source" text,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
	"trip_id" integer,
	"provider" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"requests" integer DEFAULT 1 NOT NULL,
	"cost_microcents" bigint,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "end_lat" double precision;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "end_lng" double precision;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "end_name" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "end_source" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "end_source_url" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "drive_time_minutes" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "vehicle_type" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "length_m" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "weight_kg" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "fuel_reserve_km" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "fuel_type" text;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "max_consecutive_drive_days" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "freshwater_capacity_l" double precision;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "blackwater_capacity_l" double precision;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stops" ADD CONSTRAINT "stops_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stops_leg_idx" ON "stops" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_user_idx" ON "usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_created_idx" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_provider_idx" ON "usage_events" USING btree ("provider");