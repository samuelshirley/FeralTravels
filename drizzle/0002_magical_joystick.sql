-- ==========================================================================
-- Migration 0002: Integer serial IDs → UUIDs (production-safe)
--
-- Strategy:
--   1. Add new uuid columns (new_id / new_*_id) to every affected table
--   2. Populate PK uuid columns with gen_random_uuid()
--   3. Propagate PK UUIDs into FK columns via JOINs
--   4. Drop all FK constraints that reference integer columns
--   5. Drop old integer PK/FK columns
--   6. Rename new uuid columns to the original names
--   7. Re-add PRIMARY KEY, NOT NULL, DEFAULT constraints
--   8. Re-add FK constraints
--   9. Rebuild indexes (btree on new uuid columns)
--  10. Add chat_history.seq serial column for cursor pagination
--
-- Drizzle's migrate() auto-wraps each file in a transaction, so if
-- anything fails the whole thing rolls back and production stays on
-- integer IDs. Do NOT add explicit BEGIN/COMMIT here.
--
-- IMPORTANT: Run during a maintenance window. This migration takes an
-- ACCESS EXCLUSIVE lock on every domain table while rewriting columns.
-- On a small dataset (<100k rows total) it should complete in seconds.
-- ==========================================================================

-- Enable uuid generation if not already available (Neon has it by default)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── PHASE 1: Add new UUID columns ─────────────────────────────────────

-- Primary key tables (leaf → root order doesn't matter here, just adding columns)
ALTER TABLE "vehicles"    ADD COLUMN "new_id" uuid;
ALTER TABLE "trips"       ADD COLUMN "new_id" uuid;
ALTER TABLE "legs"        ADD COLUMN "new_id" uuid;
ALTER TABLE "gpx_trails"  ADD COLUMN "new_id" uuid;
ALTER TABLE "routes"      ADD COLUMN "new_id" uuid;
ALTER TABLE "route_links" ADD COLUMN "new_id" uuid;
ALTER TABLE "costs"       ADD COLUMN "new_id" uuid;
ALTER TABLE "links"       ADD COLUMN "new_id" uuid;
ALTER TABLE "pois"        ADD COLUMN "new_id" uuid;
ALTER TABLE "stops"       ADD COLUMN "new_id" uuid;
ALTER TABLE "tasks"       ADD COLUMN "new_id" uuid;
ALTER TABLE "chat_history" ADD COLUMN "new_id" uuid;

-- Foreign key columns (new_*_id to hold the mapped UUID)
ALTER TABLE "trips"        ADD COLUMN "new_vehicle_id" uuid;
ALTER TABLE "legs"         ADD COLUMN "new_trip_id" uuid;
ALTER TABLE "costs"        ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "links"        ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "pois"         ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "pois"         ADD COLUMN "new_trip_id" uuid;
ALTER TABLE "gpx_trails"   ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "gpx_trails"   ADD COLUMN "new_trip_id" uuid;
ALTER TABLE "routes"       ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "routes"       ADD COLUMN "new_gpx_trail_id" uuid;
ALTER TABLE "route_links"  ADD COLUMN "new_route_id" uuid;
ALTER TABLE "stops"        ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "tasks"        ADD COLUMN "new_trip_id" uuid;
ALTER TABLE "tasks"        ADD COLUMN "new_leg_id" uuid;
ALTER TABLE "chat_history" ADD COLUMN "new_trip_id" uuid;
ALTER TABLE "usage_events" ADD COLUMN "new_trip_id" uuid;

-- ─── PHASE 2: Generate UUIDs for all PKs ───────────────────────────────

UPDATE "vehicles"    SET "new_id" = gen_random_uuid();
UPDATE "trips"       SET "new_id" = gen_random_uuid();
UPDATE "legs"        SET "new_id" = gen_random_uuid();
UPDATE "gpx_trails"  SET "new_id" = gen_random_uuid();
UPDATE "routes"      SET "new_id" = gen_random_uuid();
UPDATE "route_links" SET "new_id" = gen_random_uuid();
UPDATE "costs"       SET "new_id" = gen_random_uuid();
UPDATE "links"       SET "new_id" = gen_random_uuid();
UPDATE "pois"        SET "new_id" = gen_random_uuid();
UPDATE "stops"       SET "new_id" = gen_random_uuid();
UPDATE "tasks"       SET "new_id" = gen_random_uuid();
UPDATE "chat_history" SET "new_id" = gen_random_uuid();

-- ─── PHASE 3: Map FK integer values → parent UUID values ───────────────

-- trips.vehicle_id → vehicles.new_id
UPDATE "trips" t
   SET "new_vehicle_id" = v."new_id"
  FROM "vehicles" v
 WHERE t."vehicle_id" = v."id";

-- legs.trip_id → trips.new_id
UPDATE "legs" l
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE l."trip_id" = t."id";

-- costs.leg_id → legs.new_id
UPDATE "costs" c
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE c."leg_id" = l."id";

-- links.leg_id → legs.new_id
UPDATE "links" lnk
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE lnk."leg_id" = l."id";

-- pois.leg_id → legs.new_id (nullable)
UPDATE "pois" p
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE p."leg_id" = l."id";

-- pois.trip_id → trips.new_id
UPDATE "pois" p
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE p."trip_id" = t."id";

-- gpx_trails.leg_id → legs.new_id (nullable)
UPDATE "gpx_trails" g
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE g."leg_id" = l."id";

-- gpx_trails.trip_id → trips.new_id
UPDATE "gpx_trails" g
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE g."trip_id" = t."id";

-- routes.leg_id → legs.new_id
UPDATE "routes" r
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE r."leg_id" = l."id";

-- routes.gpx_trail_id → gpx_trails.new_id (nullable)
UPDATE "routes" r
   SET "new_gpx_trail_id" = g."new_id"
  FROM "gpx_trails" g
 WHERE r."gpx_trail_id" = g."id";

-- route_links.route_id → routes.new_id
UPDATE "route_links" rl
   SET "new_route_id" = r."new_id"
  FROM "routes" r
 WHERE rl."route_id" = r."id";

-- stops.leg_id → legs.new_id
UPDATE "stops" s
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE s."leg_id" = l."id";

-- tasks.trip_id → trips.new_id
UPDATE "tasks" tk
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE tk."trip_id" = t."id";

-- tasks.leg_id → legs.new_id (nullable)
UPDATE "tasks" tk
   SET "new_leg_id" = l."new_id"
  FROM "legs" l
 WHERE tk."leg_id" = l."id";

-- chat_history.trip_id → trips.new_id
UPDATE "chat_history" ch
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE ch."trip_id" = t."id";

-- usage_events.trip_id → trips.new_id (nullable)
UPDATE "usage_events" ue
   SET "new_trip_id" = t."new_id"
  FROM "trips" t
 WHERE ue."trip_id" = t."id";

-- ─── PHASE 4: Drop all FK constraints ──────────────────────────────────

ALTER TABLE "chat_history" DROP CONSTRAINT IF EXISTS "chat_history_trip_id_trips_id_fk";
ALTER TABLE "costs"        DROP CONSTRAINT IF EXISTS "costs_leg_id_legs_id_fk";
ALTER TABLE "gpx_trails"   DROP CONSTRAINT IF EXISTS "gpx_trails_leg_id_legs_id_fk";
ALTER TABLE "gpx_trails"   DROP CONSTRAINT IF EXISTS "gpx_trails_trip_id_trips_id_fk";
ALTER TABLE "legs"         DROP CONSTRAINT IF EXISTS "legs_trip_id_trips_id_fk";
ALTER TABLE "links"        DROP CONSTRAINT IF EXISTS "links_leg_id_legs_id_fk";
ALTER TABLE "pois"         DROP CONSTRAINT IF EXISTS "pois_leg_id_legs_id_fk";
ALTER TABLE "pois"         DROP CONSTRAINT IF EXISTS "pois_trip_id_trips_id_fk";
ALTER TABLE "route_links"  DROP CONSTRAINT IF EXISTS "route_links_route_id_routes_id_fk";
ALTER TABLE "routes"       DROP CONSTRAINT IF EXISTS "routes_leg_id_legs_id_fk";
ALTER TABLE "routes"       DROP CONSTRAINT IF EXISTS "routes_gpx_trail_id_gpx_trails_id_fk";
ALTER TABLE "stops"        DROP CONSTRAINT IF EXISTS "stops_leg_id_legs_id_fk";
ALTER TABLE "tasks"        DROP CONSTRAINT IF EXISTS "tasks_trip_id_trips_id_fk";
ALTER TABLE "tasks"        DROP CONSTRAINT IF EXISTS "tasks_leg_id_legs_id_fk";
ALTER TABLE "trips"        DROP CONSTRAINT IF EXISTS "trips_vehicle_id_vehicles_id_fk";
ALTER TABLE "usage_events" DROP CONSTRAINT IF EXISTS "usage_events_trip_id_trips_id_fk";

-- ─── PHASE 5: Drop old integer PK + FK columns ─────────────────────────

-- Drop PK constraints first (serial columns have implicit PK constraints)
ALTER TABLE "vehicles"    DROP CONSTRAINT IF EXISTS "vehicles_pkey";
ALTER TABLE "trips"       DROP CONSTRAINT IF EXISTS "trips_pkey";
ALTER TABLE "legs"        DROP CONSTRAINT IF EXISTS "legs_pkey";
ALTER TABLE "gpx_trails"  DROP CONSTRAINT IF EXISTS "gpx_trails_pkey";
ALTER TABLE "routes"      DROP CONSTRAINT IF EXISTS "routes_pkey";
ALTER TABLE "route_links" DROP CONSTRAINT IF EXISTS "route_links_pkey";
ALTER TABLE "costs"       DROP CONSTRAINT IF EXISTS "costs_pkey";
ALTER TABLE "links"       DROP CONSTRAINT IF EXISTS "links_pkey";
ALTER TABLE "pois"        DROP CONSTRAINT IF EXISTS "pois_pkey";
ALTER TABLE "stops"       DROP CONSTRAINT IF EXISTS "stops_pkey";
ALTER TABLE "tasks"       DROP CONSTRAINT IF EXISTS "tasks_pkey";
ALTER TABLE "chat_history" DROP CONSTRAINT IF EXISTS "chat_history_pkey";

-- Now drop the old integer columns
ALTER TABLE "vehicles"     DROP COLUMN "id";
ALTER TABLE "trips"        DROP COLUMN "id", DROP COLUMN "vehicle_id";
ALTER TABLE "legs"         DROP COLUMN "id", DROP COLUMN "trip_id";
ALTER TABLE "gpx_trails"   DROP COLUMN "id", DROP COLUMN "leg_id", DROP COLUMN "trip_id";
ALTER TABLE "routes"       DROP COLUMN "id", DROP COLUMN "leg_id", DROP COLUMN "gpx_trail_id";
ALTER TABLE "route_links"  DROP COLUMN "id", DROP COLUMN "route_id";
ALTER TABLE "costs"        DROP COLUMN "id", DROP COLUMN "leg_id";
ALTER TABLE "links"        DROP COLUMN "id", DROP COLUMN "leg_id";
ALTER TABLE "pois"         DROP COLUMN "id", DROP COLUMN "leg_id", DROP COLUMN "trip_id";
ALTER TABLE "stops"        DROP COLUMN "id", DROP COLUMN "leg_id";
ALTER TABLE "tasks"        DROP COLUMN "id", DROP COLUMN "trip_id", DROP COLUMN "leg_id";
ALTER TABLE "chat_history" DROP COLUMN "id", DROP COLUMN "trip_id";
ALTER TABLE "usage_events" DROP COLUMN "trip_id";

-- ─── PHASE 6: Rename new columns to original names ─────────────────────

ALTER TABLE "vehicles"    RENAME COLUMN "new_id" TO "id";
ALTER TABLE "trips"       RENAME COLUMN "new_id" TO "id";
ALTER TABLE "trips"       RENAME COLUMN "new_vehicle_id" TO "vehicle_id";
ALTER TABLE "legs"        RENAME COLUMN "new_id" TO "id";
ALTER TABLE "legs"        RENAME COLUMN "new_trip_id" TO "trip_id";
ALTER TABLE "gpx_trails"  RENAME COLUMN "new_id" TO "id";
ALTER TABLE "gpx_trails"  RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "gpx_trails"  RENAME COLUMN "new_trip_id" TO "trip_id";
ALTER TABLE "routes"      RENAME COLUMN "new_id" TO "id";
ALTER TABLE "routes"      RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "routes"      RENAME COLUMN "new_gpx_trail_id" TO "gpx_trail_id";
ALTER TABLE "route_links" RENAME COLUMN "new_id" TO "id";
ALTER TABLE "route_links" RENAME COLUMN "new_route_id" TO "route_id";
ALTER TABLE "costs"       RENAME COLUMN "new_id" TO "id";
ALTER TABLE "costs"       RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "links"       RENAME COLUMN "new_id" TO "id";
ALTER TABLE "links"       RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "pois"        RENAME COLUMN "new_id" TO "id";
ALTER TABLE "pois"        RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "pois"        RENAME COLUMN "new_trip_id" TO "trip_id";
ALTER TABLE "stops"       RENAME COLUMN "new_id" TO "id";
ALTER TABLE "stops"       RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "tasks"       RENAME COLUMN "new_id" TO "id";
ALTER TABLE "tasks"       RENAME COLUMN "new_trip_id" TO "trip_id";
ALTER TABLE "tasks"       RENAME COLUMN "new_leg_id" TO "leg_id";
ALTER TABLE "chat_history" RENAME COLUMN "new_id" TO "id";
ALTER TABLE "chat_history" RENAME COLUMN "new_trip_id" TO "trip_id";
ALTER TABLE "usage_events" RENAME COLUMN "new_trip_id" TO "trip_id";

-- ─── PHASE 7: Add PK constraints, NOT NULL, defaults ───────────────────

-- Set NOT NULL where required
ALTER TABLE "vehicles"    ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "trips"       ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "legs"        ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "legs"        ALTER COLUMN "trip_id" SET NOT NULL;
ALTER TABLE "gpx_trails"  ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "gpx_trails"  ALTER COLUMN "trip_id" SET NOT NULL;
ALTER TABLE "routes"      ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "routes"      ALTER COLUMN "leg_id" SET NOT NULL;
ALTER TABLE "route_links" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "route_links" ALTER COLUMN "route_id" SET NOT NULL;
ALTER TABLE "costs"       ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "costs"       ALTER COLUMN "leg_id" SET NOT NULL;
ALTER TABLE "links"       ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "links"       ALTER COLUMN "leg_id" SET NOT NULL;
ALTER TABLE "pois"        ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "pois"        ALTER COLUMN "trip_id" SET NOT NULL;
ALTER TABLE "stops"       ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "stops"       ALTER COLUMN "leg_id" SET NOT NULL;
ALTER TABLE "tasks"       ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "tasks"       ALTER COLUMN "trip_id" SET NOT NULL;
ALTER TABLE "chat_history" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "chat_history" ALTER COLUMN "trip_id" SET NOT NULL;

-- Set defaults for new rows
ALTER TABLE "vehicles"    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "trips"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "legs"        ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "gpx_trails"  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "routes"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "route_links" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "costs"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "links"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "pois"        ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "stops"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "tasks"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "chat_history" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- Primary keys
ALTER TABLE "vehicles"    ADD PRIMARY KEY ("id");
ALTER TABLE "trips"       ADD PRIMARY KEY ("id");
ALTER TABLE "legs"        ADD PRIMARY KEY ("id");
ALTER TABLE "gpx_trails"  ADD PRIMARY KEY ("id");
ALTER TABLE "routes"      ADD PRIMARY KEY ("id");
ALTER TABLE "route_links" ADD PRIMARY KEY ("id");
ALTER TABLE "costs"       ADD PRIMARY KEY ("id");
ALTER TABLE "links"       ADD PRIMARY KEY ("id");
ALTER TABLE "pois"        ADD PRIMARY KEY ("id");
ALTER TABLE "stops"       ADD PRIMARY KEY ("id");
ALTER TABLE "tasks"       ADD PRIMARY KEY ("id");
ALTER TABLE "chat_history" ADD PRIMARY KEY ("id");

-- ─── PHASE 8: Re-add FK constraints ────────────────────────────────────

ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_vehicles_id_fk"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL;

ALTER TABLE "legs" ADD CONSTRAINT "legs_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE;

ALTER TABLE "costs" ADD CONSTRAINT "costs_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "links" ADD CONSTRAINT "links_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "pois" ADD CONSTRAINT "pois_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "pois" ADD CONSTRAINT "pois_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE;

ALTER TABLE "gpx_trails" ADD CONSTRAINT "gpx_trails_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "gpx_trails" ADD CONSTRAINT "gpx_trails_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE;

ALTER TABLE "routes" ADD CONSTRAINT "routes_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "routes" ADD CONSTRAINT "routes_gpx_trail_id_gpx_trails_id_fk"
  FOREIGN KEY ("gpx_trail_id") REFERENCES "gpx_trails"("id") ON DELETE SET NULL;

ALTER TABLE "route_links" ADD CONSTRAINT "route_links_route_id_routes_id_fk"
  FOREIGN KEY ("route_id") REFERENCES "routes"("id") ON DELETE CASCADE;

ALTER TABLE "stops" ADD CONSTRAINT "stops_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE;

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_leg_id_legs_id_fk"
  FOREIGN KEY ("leg_id") REFERENCES "legs"("id") ON DELETE CASCADE;

ALTER TABLE "chat_history" ADD CONSTRAINT "chat_history_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE;

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_trip_id_trips_id_fk"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE SET NULL;

-- ─── PHASE 9: Rebuild indexes ───────────────────────────────────────────

-- Drop old indexes (they reference the old integer columns, now gone)
DROP INDEX IF EXISTS "chat_trip_idx";
DROP INDEX IF EXISTS "costs_leg_idx";
DROP INDEX IF EXISTS "gpx_trip_idx";
DROP INDEX IF EXISTS "gpx_leg_idx";
DROP INDEX IF EXISTS "legs_trip_idx";
DROP INDEX IF EXISTS "links_leg_idx";
DROP INDEX IF EXISTS "pois_trip_idx";
DROP INDEX IF EXISTS "pois_leg_idx";
DROP INDEX IF EXISTS "route_links_route_idx";
DROP INDEX IF EXISTS "routes_leg_idx";
DROP INDEX IF EXISTS "stops_leg_idx";
DROP INDEX IF EXISTS "tasks_trip_idx";
DROP INDEX IF EXISTS "tasks_leg_idx";

-- Recreate on the new uuid columns
CREATE INDEX "chat_trip_idx"         ON "chat_history" USING btree ("trip_id");
CREATE INDEX "costs_leg_idx"         ON "costs"        USING btree ("leg_id");
CREATE INDEX "gpx_trip_idx"          ON "gpx_trails"   USING btree ("trip_id");
CREATE INDEX "gpx_leg_idx"           ON "gpx_trails"   USING btree ("leg_id");
CREATE INDEX "legs_trip_idx"         ON "legs"          USING btree ("trip_id");
CREATE INDEX "links_leg_idx"         ON "links"         USING btree ("leg_id");
CREATE INDEX "pois_trip_idx"         ON "pois"          USING btree ("trip_id");
CREATE INDEX "pois_leg_idx"          ON "pois"          USING btree ("leg_id");
CREATE INDEX "route_links_route_idx" ON "route_links"   USING btree ("route_id");
CREATE INDEX "routes_leg_idx"        ON "routes"        USING btree ("leg_id");
CREATE INDEX "stops_leg_idx"         ON "stops"         USING btree ("leg_id");
CREATE INDEX "tasks_trip_idx"        ON "tasks"         USING btree ("trip_id");
CREATE INDEX "tasks_leg_idx"         ON "tasks"         USING btree ("leg_id");

-- ─── PHASE 10: Add chat_history.seq for cursor pagination ───────────────

ALTER TABLE "chat_history" ADD COLUMN "seq" serial NOT NULL;

-- Backfill seq in the same order as the old integer id (created_at ascending)
-- so existing chat threads keep their original message order.
WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS rn
  FROM "chat_history"
)
UPDATE "chat_history" ch
   SET "seq" = n.rn
  FROM numbered n
 WHERE ch."id" = n."id";

-- Reset the sequence so the next INSERT picks up after the max backfilled value
SELECT setval(
  pg_get_serial_sequence('chat_history', 'seq'),
  COALESCE((SELECT MAX("seq") FROM "chat_history"), 0)
);

-- ─── PHASE 11: Drop leftover serial sequences ──────────────────────────
-- When you drop a serial column, Postgres doesn't always drop the backing
-- sequence. Clean up any orphans.

DROP SEQUENCE IF EXISTS "vehicles_id_seq"    CASCADE;
DROP SEQUENCE IF EXISTS "trips_id_seq"       CASCADE;
DROP SEQUENCE IF EXISTS "legs_id_seq"        CASCADE;
DROP SEQUENCE IF EXISTS "gpx_trails_id_seq"  CASCADE;
DROP SEQUENCE IF EXISTS "routes_id_seq"      CASCADE;
DROP SEQUENCE IF EXISTS "route_links_id_seq" CASCADE;
DROP SEQUENCE IF EXISTS "costs_id_seq"       CASCADE;
DROP SEQUENCE IF EXISTS "links_id_seq"       CASCADE;
DROP SEQUENCE IF EXISTS "pois_id_seq"        CASCADE;
DROP SEQUENCE IF EXISTS "stops_id_seq"       CASCADE;
DROP SEQUENCE IF EXISTS "tasks_id_seq"       CASCADE;
DROP SEQUENCE IF EXISTS "chat_history_id_seq" CASCADE;
