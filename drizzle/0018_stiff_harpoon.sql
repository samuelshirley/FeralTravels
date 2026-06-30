CREATE TABLE IF NOT EXISTS "penny_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"user_message" text NOT NULL,
	"images" jsonb,
	"result_response" text,
	"result_meta" jsonb,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "penny_turns" ADD CONSTRAINT "penny_turns_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "penny_turns" ADD CONSTRAINT "penny_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "penny_turns_idempotency_key_idx" ON "penny_turns" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "penny_turns_trip_idx" ON "penny_turns" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "penny_turns_trip_status_idx" ON "penny_turns" USING btree ("trip_id","status");