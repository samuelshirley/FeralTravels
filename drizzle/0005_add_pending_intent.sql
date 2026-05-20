-- ==========================================================================
-- Migration 0005: Add pending_intent column to trips
--
-- Stores the user's trip description during onboarding so it can be sent
-- to the LLM after all onboarding questions (vehicle profile, etc.) are
-- complete. Cleared after handoff to Penny.
-- ==========================================================================

ALTER TABLE "trips"
  ADD COLUMN "pending_intent" text;
