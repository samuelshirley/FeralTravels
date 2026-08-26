CREATE TABLE IF NOT EXISTS "subscription_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text,
	"type" text NOT NULL,
	"event_time_ms" bigint,
	"payload" jsonb,
	"outcome" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"product_id" text,
	"current_period_end" timestamp,
	"original_transaction_id" text,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" text,
	"revoked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_alerts" (
	"user_id" text NOT NULL,
	"threshold" text NOT NULL,
	"microcents_at_firing" bigint,
	"fired_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_alerts_user_id_threshold_pk" PRIMARY KEY("user_id","threshold")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "comped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_alerts" ADD CONSTRAINT "usage_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_events_event_id_idx" ON "subscription_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_events_user_idx" ON "subscription_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_original_tx_idx" ON "subscriptions" USING btree ("original_transaction_id");