-- Stage A schema migration
-- 1. Drop the unused `fuel_reserve_km` column on vehicles. We now use a flat
--    20% buffer rule: effective_range_km = fuel_economy_kmpl × fuel_tank_l × 0.8.
-- 2. Add `onboarding_state` to trips so the client knows which static Penny
--    form question to render on mount.
-- 3. Add `fuel_status` to legs so the UI can show a spinner while the
--    server-side fuel planner is running.
-- 4. Add `kind` to chat_history so we can distinguish the deterministic
--    onboarding form rows from live Anthropic chat.

ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "fuel_reserve_km";--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN IF NOT EXISTS "onboarding_state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "legs" ADD COLUMN IF NOT EXISTS "fuel_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_history" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint

-- Backfill: any trip that already has legs is past onboarding; mark them done
-- so we don't show the first-run form to a returning user.
UPDATE "trips"
SET "onboarding_state" = 'done'
WHERE "id" IN (SELECT DISTINCT "trip_id" FROM "legs");
