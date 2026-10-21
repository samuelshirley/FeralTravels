-- When the account agreed to its content being sent to Anthropic (App Review
-- 5.1.2(i), revised 2026-10-16). NULL on every existing row, which means "not
-- yet asked": those accounts see the consent sheet before Penny's next turn,
-- and every route that would send their content to Anthropic answers 403
-- `ai_consent_required` until they agree. Additive; either order of deploy is
-- safe — old code never reads it, new code reads NULL as "ask".
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_consent_at" timestamp with time zone;
