-- Which consent sheet the account agreed to, and when (App Review 5.1.2(i)).
-- Version 2 is the sheet that names TypeSafe beside Anthropic
-- (src/lib/aiConsent.ts). `ai_consent_at` keeps its meaning — the FIRST
-- agreement to any version, which is what the 403 gate reads — so no existing
-- row changes: NULL here with `ai_consent_at` set means version 1, the
-- Anthropic-only sheet those accounts actually saw. Those accounts keep Penny
-- and are re-asked with the newer sheet; until they agree, Jev is never called
-- for them. Additive; either order of deploy is safe — old code never reads
-- these columns, new code reads NULL as version 1 (or none).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_consent_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_consent_version_at" timestamp with time zone;
