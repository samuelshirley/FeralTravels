CREATE TABLE IF NOT EXISTS "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"email" text NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"expires_at" timestamp,
	"redeemed_at" timestamp,
	"redeemed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_idx" ON "promo_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_codes_email_idx" ON "promo_codes" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_codes_created_at_idx" ON "promo_codes" USING btree ("created_at");