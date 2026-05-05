-- Vehicle profile simplification.
--
-- Replaces the wide vehicle row (height/length/weight + spec/real-world fuel
-- economy + tank size + fuel type + fuel timing + fresh/black water capacities
-- + vehicle type + notes) with a single user-stated `refill_distance_km` —
-- "I want Penny to plan a fuel stop every ~X km, not because of tank math
-- but because that's how I like to drive."
--
-- Why this is safer than dropping straight away:
--   * Trips reference vehicles by FK, not snapshot. Penny re-projects the
--     vehicle on every replan via projectVehicle()/computeEffectiveRangeKm()
--     in src/lib/penny/context.ts — those readers move to refill_distance_km
--     in the same release.
--   * Old vehicles have fuel data on file. We BACKFILL refill_distance_km
--     from `(real_world_kmpl ?? fuel_economy_kmpl) × fuel_tank_l × 0.8` (the
--     same 20% reserve formula those readers used) BEFORE the column drops,
--     so existing trips keep planning at the same effective range.
--   * If the backfill produces NULL (e.g. a vehicle never had fuel data), it
--     stays NULL after the migration. Penny is being updated to handle the
--     null case (no auto fuel planning, prompt the user to fill it in next
--     time they edit the vehicle) rather than crashing.
--
-- Also adds `users.units_pref` ('metric'|'imperial', default 'metric'). The
-- DB always stores km/L/kg internally; this flag only affects display +
-- form input. Enforced as text rather than an enum to keep migrations
-- cheap if we add a third option later.

-- ---------------------------------------------------------------------------
-- 1. Add new columns (nullable so the migration is non-blocking on hot tables).
-- ---------------------------------------------------------------------------
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "refill_distance_km" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "units_pref" text DEFAULT 'metric' NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Backfill refill_distance_km from existing fuel data, BEFORE dropping the
--    columns it depends on. Mirrors computeEffectiveRangeKm() in
--    src/lib/penny/context.ts: prefer real-world economy when set; multiply
--    by tank size; apply the 20% flat reserve. Round to integer because the
--    new column is `integer` (users don't need sub-km precision for a
--    refuel cadence).
-- ---------------------------------------------------------------------------
UPDATE "vehicles"
SET "refill_distance_km" = ROUND(
  COALESCE("real_world_kmpl", "fuel_economy_kmpl") * "fuel_tank_l" * 0.8
)::integer
WHERE "fuel_tank_l" IS NOT NULL
  AND COALESCE("real_world_kmpl", "fuel_economy_kmpl") IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Drop the columns the new model no longer needs. Postgres lets us drop
--    multiple columns in a single ALTER TABLE — atomic and faster than 12
--    separate statements.
-- ---------------------------------------------------------------------------
ALTER TABLE "vehicles"
  DROP COLUMN IF EXISTS "vehicle_type",
  DROP COLUMN IF EXISTS "notes",
  DROP COLUMN IF EXISTS "height_cm",
  DROP COLUMN IF EXISTS "length_m",
  DROP COLUMN IF EXISTS "weight_kg",
  DROP COLUMN IF EXISTS "fuel_economy_kmpl",
  DROP COLUMN IF EXISTS "real_world_kmpl",
  DROP COLUMN IF EXISTS "fuel_tank_l",
  DROP COLUMN IF EXISTS "fuel_type",
  DROP COLUMN IF EXISTS "fuel_timing_pref",
  DROP COLUMN IF EXISTS "freshwater_capacity_l",
  DROP COLUMN IF EXISTS "blackwater_capacity_l";
