-- Foreground time (seconds) per viewport bucket for admin product mix. Client reporter upserts deltas.
CREATE TABLE IF NOT EXISTS "user_viewport_time" (
	"user_id" text NOT NULL,
	"viewport" text NOT NULL,
	"total_seconds" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_viewport_time_user_id_viewport_pk" PRIMARY KEY("user_id","viewport")
);
--> statement-breakpoint
ALTER TABLE "user_viewport_time" ADD CONSTRAINT "user_viewport_time_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_viewport_time_user_idx" ON "user_viewport_time" USING btree ("user_id");
