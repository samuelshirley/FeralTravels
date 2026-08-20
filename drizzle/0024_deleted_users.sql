CREATE TABLE IF NOT EXISTS "deleted_users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"email_encrypted" text,
	"sign_in_providers" text,
	"account_created_at" timestamp,
	"trip_count" integer DEFAULT 0 NOT NULL,
	"vehicle_count" integer DEFAULT 0 NOT NULL,
	"chat_message_count" integer DEFAULT 0 NOT NULL,
	"deleted_by" text DEFAULT 'self' NOT NULL,
	"deleted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_users_email_hash_idx" ON "deleted_users" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_users_deleted_at_idx" ON "deleted_users" USING btree ("deleted_at");
--> statement-breakpoint
-- Foreign keys are NOT indexed automatically by Postgres, and account deletion
-- is the operation that finally makes that expensive: each ON DELETE CASCADE /
-- SET NULL action runs once per deleted parent row, so an unindexed FK means a
-- sequential scan per row, inside the deletion transaction. `usage_events` is
-- the dangerous one — it grows fastest, and its `trip_id` action fires once per
-- trip the user owns. Added here rather than in a later migration so no
-- deployment ever exists where deletion is live and these are missing.
CREATE INDEX IF NOT EXISTS "usage_trip_idx" ON "usage_events" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_user_idx" ON "accounts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "penny_turns_user_idx" ON "penny_turns" USING btree ("user_id");
