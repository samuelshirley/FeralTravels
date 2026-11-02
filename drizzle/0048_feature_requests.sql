-- Feature requests: an admin-written list the iOS app shows, with one vote per
-- user per request. The vote table's composite primary key IS the one-vote
-- rule; both of its foreign keys cascade, so deleting an account or a request
-- removes the votes with it. No count column: the count is COUNT(*) of the
-- vote rows. Additive only — two new tables and a new enum; old code never
-- reads them, so either order of deploy is safe.
DO $$ BEGIN CREATE TYPE "public"."feature_request_status" AS ENUM('open', 'in_progress', 'not_doing'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" "feature_request_status" DEFAULT 'open' NOT NULL,
	"reply" text,
	"reply_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_request_votes" (
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_request_votes_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feature_request_votes" ADD CONSTRAINT "feature_request_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feature_request_votes" ADD CONSTRAINT "feature_request_votes_request_id_feature_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."feature_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_request_votes_request_idx" ON "feature_request_votes" USING btree ("request_id");
