-- 0006: Nightly Replan — schema changes
-- Adds trip_status enum, constraint_type enum, leg_constraints table,
-- GPS position fields on trips, and parsed date columns.

-- ── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE "public"."trip_status" AS ENUM('draft', 'active', 'paused', 'completed');
CREATE TYPE "public"."constraint_type" AS ENUM('arrive_by', 'depart_after', 'flexible');

-- ── Trips: parsed dates, trip_status, GPS position ─────────────────────────

ALTER TABLE "trips" ADD COLUMN "start_date_parsed" date;
ALTER TABLE "trips" ADD COLUMN "end_date_parsed" date;
ALTER TABLE "trips" ADD COLUMN "trip_status" "trip_status" DEFAULT 'draft' NOT NULL;
ALTER TABLE "trips" ADD COLUMN "last_known_lat" double precision;
ALTER TABLE "trips" ADD COLUMN "last_known_lng" double precision;
ALTER TABLE "trips" ADD COLUMN "position_updated_at" timestamp;

-- Index for cron to find active trips efficiently
CREATE INDEX "trips_trip_status_idx" ON "trips" USING btree ("trip_status");

-- ── Backfill: try to parse existing text dates into proper date columns ────
-- Handles ISO dates (2026-05-28), "May 28, 2026", "May 28" (assumes current year).
-- Anything unparseable stays NULL → app will prompt user to confirm.

UPDATE "trips"
SET "start_date_parsed" = CASE
  WHEN "start_date" IS NOT NULL
    AND "start_date" ~ '^\d{4}-\d{2}-\d{2}$'
    THEN "start_date"::date
  WHEN "start_date" IS NOT NULL
    THEN (
      SELECT to_date("start_date", 'Month DD, YYYY')
      WHERE "start_date" ~ '^[A-Za-z]+ \d{1,2}, \d{4}$'
    )
  ELSE NULL
END,
"end_date_parsed" = CASE
  WHEN "end_date" IS NOT NULL
    AND "end_date" ~ '^\d{4}-\d{2}-\d{2}$'
    THEN "end_date"::date
  WHEN "end_date" IS NOT NULL
    THEN (
      SELECT to_date("end_date", 'Month DD, YYYY')
      WHERE "end_date" ~ '^[A-Za-z]+ \d{1,2}, \d{4}$'
    )
  ELSE NULL
END;

-- ── Leg constraints table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "leg_constraints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "leg_id" uuid NOT NULL REFERENCES "legs"("id") ON DELETE CASCADE,
  "constraint_type" "constraint_type" NOT NULL,
  "constraint_datetime" timestamp with time zone,
  "buffer_minutes" integer DEFAULT 60 NOT NULL,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "leg_constraints_leg_idx" ON "leg_constraints" USING btree ("leg_id");
