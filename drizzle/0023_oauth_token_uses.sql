CREATE TABLE IF NOT EXISTS "oauth_token_uses" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_uses_email_used_at_idx" ON "oauth_token_uses" USING btree ("email","used_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_token_uses_expires_idx" ON "oauth_token_uses" USING btree ("expires");
