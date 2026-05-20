-- ==========================================================================
-- Migration 0003: Add rest_days_after_driving to vehicles, leg_type to legs
--
-- 1. vehicles.rest_days_after_driving: integer, nullable, how many rest days
--    the user needs after a driving streak.
-- 2. legs.leg_type: text, NOT NULL, default 'drive'. Either 'drive' or 'rest'.
--    Existing rows default to 'drive' (backward compatible).
-- ==========================================================================

-- Add rest_days_after_driving to vehicles
ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "rest_days_after_driving" integer;

-- Add leg_type to legs with default 'drive' for existing rows
ALTER TABLE "legs"
  ADD COLUMN IF NOT EXISTS "leg_type" text DEFAULT 'drive' NOT NULL;
