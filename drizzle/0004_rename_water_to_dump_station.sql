-- ==========================================================================
-- Migration 0004: Rename water/blackwater fields to dump_station
--
-- The product now uses "dump station" (not "water refill" / "blackwater dump")
-- because all dump stations provide both fresh water and waste disposal.
--
-- 1. Rename water_refill_days → dump_station_interval_days
-- 2. Rename water_tracking_enabled → dump_station_tracking_enabled
-- 3. Drop blackwater_refill_days (redundant — dump station handles both)
--
-- Uses ALTER COLUMN RENAME to preserve existing data.
-- ==========================================================================

-- Rename water_refill_days → dump_station_interval_days
ALTER TABLE "vehicles"
  RENAME COLUMN "water_refill_days" TO "dump_station_interval_days";

-- Rename water_tracking_enabled → dump_station_tracking_enabled
ALTER TABLE "vehicles"
  RENAME COLUMN "water_tracking_enabled" TO "dump_station_tracking_enabled";

-- Drop blackwater_refill_days — dump station covers both fresh + waste
ALTER TABLE "vehicles"
  DROP COLUMN IF EXISTS "blackwater_refill_days";
