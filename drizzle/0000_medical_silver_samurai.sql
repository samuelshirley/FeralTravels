CREATE TABLE IF NOT EXISTS "accounts" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"changes_made" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer NOT NULL,
	"item" text NOT NULL,
	"estimate" text NOT NULL,
	"is_total" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpx_trails" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer,
	"trip_id" integer NOT NULL,
	"name" text NOT NULL,
	"filename" text NOT NULL,
	"source" text,
	"source_url" text,
	"distance_km" double precision,
	"surface" text,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"sort_order" integer NOT NULL,
	"title" text NOT NULL,
	"label" text,
	"start_name" text,
	"end_name" text,
	"start_lat" double precision,
	"start_lng" double precision,
	"end_lat" double precision,
	"end_lng" double precision,
	"dates" text,
	"distance_km" double precision,
	"drive_time_minutes" integer,
	"terrain" text,
	"overnight" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"color" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "links" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"type" text DEFAULT 'general' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pois" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer,
	"trip_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"type" text,
	"description" text,
	"rating" double precision,
	"url" text,
	"data" text,
	"last_verified" timestamp,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "route_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_id" integer NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"type" text DEFAULT 'other' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"leg_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"distance_km" double precision,
	"surface" text,
	"status" text DEFAULT 'option' NOT NULL,
	"gpx_trail_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"leg_id" integer,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reference_url" text,
	"reference_label" text,
	"reference_phone" text,
	"answer" text,
	"answer_source_url" text,
	"answer_image_url" text,
	"created_by" text DEFAULT 'user' NOT NULL,
	"due_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trips" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"vehicle_id" integer,
	"name" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"height_cm" integer,
	"fuel_economy_kmpl" double precision,
	"fuel_tank_l" double precision,
	"max_drive_hours_per_day" double precision,
	"max_drive_hours_per_week" double precision,
	"water_refill_days" integer,
	"blackwater_refill_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verificationTokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationTokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_history" ADD CONSTRAINT "chat_history_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "costs" ADD CONSTRAINT "costs_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gpx_trails" ADD CONSTRAINT "gpx_trails_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gpx_trails" ADD CONSTRAINT "gpx_trails_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "legs" ADD CONSTRAINT "legs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "links" ADD CONSTRAINT "links_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pois" ADD CONSTRAINT "pois_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pois" ADD CONSTRAINT "pois_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "route_links" ADD CONSTRAINT "route_links_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routes" ADD CONSTRAINT "routes_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routes" ADD CONSTRAINT "routes_gpx_trail_id_gpx_trails_id_fk" FOREIGN KEY ("gpx_trail_id") REFERENCES "public"."gpx_trails"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_trip_idx" ON "chat_history" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "costs_leg_idx" ON "costs" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gpx_trip_idx" ON "gpx_trails" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gpx_leg_idx" ON "gpx_trails" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legs_trip_idx" ON "legs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "links_leg_idx" ON "links" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pois_trip_idx" ON "pois" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pois_leg_idx" ON "pois" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "route_links_route_idx" ON "route_links" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routes_leg_idx" ON "routes" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_trip_idx" ON "tasks" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_leg_idx" ON "tasks" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trips_user_idx" ON "trips" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trips_template_idx" ON "trips" USING btree ("is_template");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vehicles_user_idx" ON "vehicles" USING btree ("user_id");